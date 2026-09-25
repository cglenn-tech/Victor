"""
BuildHarvey Desktop Agent — headless background daemon.

Run:  python main.py
      (or launched automatically by app.py after credential and permissions are set up)

Loop:
  1. Check if a work session is active (user clicked Start on buildharvey.com).
  2. Each cycle: capture screen → extract context → build Observation.
  3. Screenshots accumulate into batches (~5). A full batch is sent as ONE
     request to the self-hosted vision model (model_client), which returns one
     structured observation. Episodes are grouped around observations
     using explicit matter identity.
  4. If no screenshot or server returns None: update metadata context only.
  5. On episode close: finalize → persist to SQLite → enqueue server sync.
  6. On session end: broadcast daily_review so the web dashboard shows the modal.

Session gate:
  - Recording begins when the user clicks Start on buildharvey.com (Realtime).
  - All browser tabs closing expires the server lease after 10 minutes.
  - Sign-out and network failures stop capture at the next session check.
  - Active episode is finalized on Stop.

Phase 1 (ENABLE_CAPTURE_LEASES=true):
  - Per-window consent required before any observation is recorded.
  - Unauthorized windows generate ObservationGaps.
  - Security boundary crossings (lock/logout/restart) invalidate all leases.

Startup:
  - Purge stale temp frames (crash safety: delete frames >1h old).
  - Mark locally invalid episodes (not deleted — just flagged).
  - Enqueue server cleanup for those IDs.
  - Increment session epoch (detects crash recovery).

Degraded mode (model endpoint unreachable or unconfigured):
  - Model analysis returns None; no Observations are created; no Episodes opened.
  - Metadata tracked in memory only; batches retried then dropped safely.
  - System keeps running; no garbage Episodes created.
"""
import threading
import time
import traceback
import urllib.error
from typing import Callable, Optional

from dotenv import load_dotenv
load_dotenv()

import config
import auth
import database
import finalizer
import model_client
import observer
import realtime_client
import sync
import vision
from episode import Episode
from episode_engine import EpisodeEngine
from observer import _CONSENT_BLOCKED


def _establish_session(owner, token, stop_event, state_callback=None) -> bool:
    """Recover from a transient startup failure without ever starting capture."""
    while not stop_event.is_set():
        if (auth.read_user_id(), auth.read_credential()) != (owner, token):
            return False
        try:
            result = auth._api_bearer('/api/device/heartbeat', token, method='POST')
            if result.get('ok') is True:
                server_owner = result.get('user_id')
                if not server_owner or (owner and owner != server_owner) or auth.read_credential() != token:
                    if state_callback:
                        state_callback('reconnect_required')
                    return False
                if not owner:
                    auth.store_user_id(server_owner)
                if result.get('device_id'):
                    auth.store_device_id(result['device_id'])
                return True
        except urllib.error.HTTPError as exc:
            if exc.code in (401, 403):
                if auth.read_credential() == token:
                    auth.delete_credential()
                if state_callback:
                    state_callback('reconnect_required')
                return False
        except Exception:
            pass
        if state_callback:
            state_callback('connecting')
        stop_event.wait(5)
    return False


def main(
    state_callback: Optional[Callable[[str], None]] = None,
    stop_event: Optional[threading.Event] = None,
) -> None:
    stop_event = stop_event or threading.Event()
    owner, token = auth.read_user_id(), auth.read_credential()
    if not token:
        if state_callback:
            state_callback('reconnect_required')
        return
    realtime_client.force_stop()
    realtime_client.set_status('connecting')
    if not _establish_session(owner, token, stop_event, state_callback):
        return
    owner = auth.read_user_id()
    realtime_client.start()
    model_client.bind_session(owner, token, stop_event)
    try:
        database.purge_stale_temp_frames()
    except Exception:
        pass
    conn = database.connect(owner)
    engine = EpisodeEngine()
    batcher = vision.ObservationBatcher()
    open_gap_id = None
    consent_manager = None
    state = 'idle'
    try:
        crashed = database.check_dirty_shutdown(conn)
        database.mark_dirty_shutdown(conn)
        database.mark_invalid_episodes(conn)
        if config.ENABLE_CAPTURE_LEASES:
            from consent_manager import ConsentManager
            consent_manager = ConsentManager(conn)
            if crashed:
                consent_manager.invalidate_all('app_crashed')
            invalidated = consent_manager.get_invalidated_leases()
            if invalidated:
                consent_manager.begin_batch_reconsent(invalidated)
        observer.reset()
        sync.start()  # persisted unsynced rows are the recovery queue
        realtime_client.set_status('idle')
        while not stop_event.is_set():
            if (auth.read_user_id(), auth.read_credential()) != (owner, token):
                break
            try:
                if realtime_client.is_recording_active():
                    if state != 'recording':
                        realtime_client.set_status('recording')
                        state = 'recording'
                    open_gap_id = _cycle(conn, engine, batcher, consent_manager, open_gap_id)
                    if state_callback:
                        state_callback('recording')
                    stop_event.wait(config.CAPTURE_INTERVAL_SECONDS)
                else:
                    if state == 'recording' or len(batcher):
                        realtime_client.set_status('finalizing')
                        _flush_batcher(conn, engine, batcher)
                        if engine.active:
                            _close_and_save(conn, engine.force_close_active())
                            realtime_client.broadcast_daily_review()
                        if open_gap_id:
                            database.close_gap(conn, open_gap_id)
                            open_gap_id = None
                        observer.reset()
                    state = 'idle'
                    realtime_client.set_status('error' if batcher.last_error else 'idle')
                    if state_callback:
                        state_callback('error' if batcher.last_error else 'idle')
                    stop_event.wait(1)
            except Exception:
                traceback.print_exc()
                realtime_client.set_status('error')
                if state_callback:
                    state_callback('error')
                observer.reset()
                stop_event.wait(config.CAPTURE_INTERVAL_SECONDS)
    except KeyboardInterrupt:
        stop_event.set()
    finally:
        # Shutdown never starts new model requests. Completed observations still
        # commit locally, even when the token was revoked while analysis ran.
        try:
            if engine.active:
                _close_and_save(conn, engine.force_close_active())
            if open_gap_id:
                database.close_gap(conn, open_gap_id)
            database.mark_clean_shutdown(conn)
        finally:
            batcher.discard()
            observer.reset()
            realtime_client.force_stop()
            conn.close()


def _cycle(
    conn,
    engine: EpisodeEngine,
    batcher: vision.ObservationBatcher,
    consent_manager,
    open_gap_id: Optional[str],
) -> Optional[str]:
    """
    Run one capture cycle. Returns the current open_gap_id (possibly new or
    None if a previously open gap was just closed).
    """
    now = time.time()
    obs = observer.observe(consent_manager=consent_manager)

    # ── Consent-blocked sentinel (Phase 1) ────────────────────────────────────
    if obs is _CONSENT_BLOCKED:
        # Window not authorized — open or extend an ObservationGap
        if open_gap_id is None:
            prev_ep_id = engine.active.id if engine.active else None
            open_gap_id = database.open_gap(conn, "window_not_consented", prev_ep_id)
        if engine.active:
            engine.active.pause_timing()
        return open_gap_id

    # ── Close any open gap when capture resumes ───────────────────────────────
    if open_gap_id is not None and obs is not None:
        next_ep_id = engine.active.id if engine.active else None
        database.close_gap(conn, open_gap_id, next_episode_id=next_ep_id)
        open_gap_id = None

    # Filter out system/agent observations before they reach the Episode Engine
    if obs is not None and not observer.is_user_work(obs):
        if obs.screenshot_path:
            from pathlib import Path
            Path(obs.screenshot_path).unlink(missing_ok=True)
        obs = None

    if obs is None:
        # No screen change (or filtered) — update activity timestamp, check inactivity
        so = batcher.maybe_idle_flush()
        if so is not None:
            _handle_observation(conn, engine, so)
        closed = engine.check_inactivity(now)
        if closed:
            _close_and_save(conn, closed)
        return open_gap_id

    if obs.screenshot_path:
        # Accumulate the screenshot into the next batch; a full batch produces
        # one structured observation which drives episode grouping.
        so = batcher.add(obs)
        if so is not None:
            _handle_observation(conn, engine, so)
            realtime_client.set_status('recording')
        elif batcher.last_error:
            realtime_client.set_status('error')
    else:
        # Metadata path: track context only, never open/close episodes
        engine.ingest_metadata(obs)

    # Flush a partial batch when no new screenshots have arrived for a while
    so = batcher.maybe_idle_flush()
    if so is not None:
        _handle_observation(conn, engine, so)

    # Also check inactivity in case of long metadata-only stretches
    closed = engine.check_inactivity(now)
    if closed:
        _close_and_save(conn, closed)

    return open_gap_id


def _handle_observation(conn, engine: EpisodeEngine, so) -> None:
    """Persist + sync a completed observation, then group it into an episode."""
    result = engine.ingest_observation(so)
    if result and result.closed_episode:
        _close_and_save(conn, result.closed_episode)
    if not engine.active:
        return
    # Persist a current parent snapshot before its child. Both survive crashes.
    _close_and_save(conn, engine.active)


def _flush_batcher(conn, engine: EpisodeEngine, batcher) -> None:
    """Complete any pending batch (e.g. at session end) before closing episodes."""
    try:
        so = batcher.flush(force=True)
        if so is not None:
            _handle_observation(conn, engine, so)
    except Exception:
        traceback.print_exc()


def _close_and_save(conn, episode: Episode) -> None:
    """Persist one coherent snapshot, including its original observations."""
    if episode is None:
        return
    finalizer.finalize(episode)

    # Short observations are still durable and reviewable.
    # Read classification metadata set by finalizer
    activity_class = getattr(episode, "_activity_classification", None)
    class_confidence = getattr(episode, "_classification_confidence", None)
    inference_failed = getattr(episode, "_has_inference_failure", False)

    database.save_work_snapshot(
        conn, episode,
        activity_classification=activity_class,
        classification_confidence=class_confidence,
        has_inference_failure=inference_failed,
    )
    sync.enqueue_episode(episode.to_dict())
    print(
        f"[agent] saved episode {episode.id[:8]} "
        f"({episode.duration_minutes:.1f}min, {len(episode.key_observations)} observations)"
    )


if __name__ == "__main__":
    main()

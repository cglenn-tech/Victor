"""
Async background sync worker.
The main loop never waits for the server — SQLite is written first.
Syncs episodes and observations via device-token API routes — no database
credentials, and no screenshots ever leave the device.
"""
import json
import queue
import sqlite3
import threading
import time as _time
import traceback
import urllib.request
import urllib.error

import auth
import config
import database
from bh_logging import get_logger

log = get_logger("sync")

_queue: queue.Queue = queue.Queue()


def start() -> None:
    t = threading.Thread(target=_worker, name="sync-worker", daemon=True)
    t.start()
    log.info("sync.started")


def enqueue_episode(episode_dict: dict) -> None:
    """Queue a finalized episode for server sync."""
    _queue.put(episode_dict)


def enqueue_observation(obs_dict: dict) -> None:
    """Queue a completed structured observation for server sync."""
    _queue.put({"_type": "observation", "observation": obs_dict})


def enqueue_cleanup(invalid_ids: list[str]) -> None:
    """Queue an is_reportable=false update to the server for known invalid episodes."""
    if invalid_ids:
        _queue.put({"_type": "cleanup", "ids": invalid_ids})


def _worker() -> None:
    conn = database.connect()
    token = auth.read_credential()
    if not token:
        log.warning("sync.no_credential")
    while True:
        task = _queue.get()
        try:
            if isinstance(task, dict) and task.get("_type") == "cleanup":
                _cleanup(token, task["ids"])
            elif isinstance(task, dict) and task.get("_type") == "observation":
                _sync_observation(token, task["observation"], conn)
            else:
                _upsert(token, task, conn)
        except Exception:
            traceback.print_exc()
        finally:
            _queue.task_done()


def _post(path: str, body: dict, token: str) -> dict:
    url = f"{config.BASE_URL}{path}"
    payload = json.dumps(body).encode()
    req = urllib.request.Request(
        url,
        data=payload,
        headers={
            'Content-Type': 'application/json',
            'Authorization': f'Bearer {token}',
        },
        method='POST',
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())


def _sync_observation(token: str | None, obs: dict, conn: sqlite3.Connection) -> None:
    """Push one observation to /api/observations/sync (device token auth)."""
    if not token:
        return
    obs_id = obs.get("id", "")
    for attempt in range(5):
        try:
            _post("/api/observations/sync", {"observations": [obs]}, token)
            database.mark_observation_synced(conn, obs_id)
            log.info("sync.observation_synced", obs_id=obs_id[:8])
            return
        except Exception as exc:
            log.warning("sync.observation_attempt_failed", attempt=attempt + 1, error=str(exc))
            _time.sleep(2 ** attempt)
    log.error("sync.observation_gave_up", obs_id=obs_id[:8])


def _upsert(token: str | None, episode_dict: dict, conn: sqlite3.Connection) -> None:
    if not token:
        return
    episode_id = episode_dict["id"]
    # Strip legacy field — no screenshots are ever uploaded
    episode_dict.pop("evidence_paths", None)

    for attempt in range(5):
        try:
            _post('/api/episodes/sync', episode_dict, token)
            database.mark_synced(conn, episode_id)
            log.info("sync.episode_synced", episode_id=episode_id[:8])
            break
        except Exception as exc:
            log.warning("sync.attempt_failed", attempt=attempt + 1, error=str(exc))
            _time.sleep(2 ** attempt)
    else:
        log.error("sync.gave_up", episode_id=episode_id[:8])


def _cleanup(token: str | None, invalid_ids: list[str]) -> None:
    if not token or not invalid_ids:
        return
    try:
        _post('/api/episodes/invalidate', {"ids": invalid_ids}, token)
        log.info("sync.invalidated", count=len(invalid_ids))
    except Exception as exc:
        log.error("sync.cleanup_failed", error=str(exc))

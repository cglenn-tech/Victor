"""
Episode Finalizer — Phase 2 of the privacy architecture.

Runs once when an episode closes, before it is persisted.

Screenshot lifecycle (Phase 2 target: zero persistent raw screenshots):
  - Raw frames are ephemeral: captured to /tmp, used for OCR/diff, then overwritten.
  - The batcher deletes each screenshot as soon as its batch is processed.
  - Structured Episode data (key_observations, activity_classification, confidence)
    survives; raw frames do not.

Key observations path (in priority order):
  1. Structured observations attached to the episode (model batch output)
  2. Template fallback — deterministic, no network

Core philosophy: produce observations that read like an executive assistant
summarized the work — not browser history. Synthesize. Connect. Reconstruct.
"""
from pathlib import Path

import config
import observations as obs_mod
from bh_logging import get_logger
from episode import Episode, KeyObservation, RawObservation

log = get_logger("finalizer")

def finalize(episode: Episode) -> None:
    """
    Process a closed episode in place.
    Sets episode.key_observations. Deletes all temporary screenshot files.
    episode.evidence_paths is always set to [] (no persistent raw screenshots).
    """
    try:
        key_obs, activity_class, class_confidence, inference_failed = _generate_observations(episode)
        episode.key_observations = key_obs
        # Store classification metadata on the episode object for the DB caller to use
        episode._activity_classification = activity_class
        episode._classification_confidence = class_confidence
        episode._has_inference_failure = inference_failed
    finally:
        # Phase 2: delete all temporary screenshots immediately — no evidence/ directory.
        _delete_all_screenshots(episode)
        episode.evidence_paths = []
        episode._raw_observations = []


def _generate_observations(
    episode: Episode,
) -> tuple[list[KeyObservation], str | None, float | None, bool]:
    """
    Generate key observations for a closed episode.
    Returns: (key_observations, activity_classification, classification_confidence, inference_failed)
    """
    if episode._structured_observations:
        return _structured_key_observations(episode)

    obs = _template_observations(episode._raw_observations)
    # The model contributed nothing to this episode — flag it as degraded
    return obs, None, None, True


# ── Structured observations path (primary) ──────────────────────────────────

def _structured_key_observations(
    episode: Episode,
) -> tuple[list[KeyObservation], str | None, float | None, bool]:
    """Build key observations from the structured model observations on this episode."""
    key_obs: list[KeyObservation] = []
    seen: set[str] = set()
    for so in episode._structured_observations:
        text = so.observation.strip()
        title = so.title.strip()
        if title and not text.lower().startswith(title.lower()):
            text = f"{title}: {text}"
        if not text or text.lower() in seen:
            continue
        seen.add(text.lower())
        stamp = (so.start_time or "")[11:16] or episode.started_at[11:16]
        key_obs.append(KeyObservation(timestamp=stamp, text=text))
        if len(key_obs) >= config.MAX_KEY_OBSERVATIONS:
            break

    counts: dict[str, int] = {}
    for so in episode._structured_observations:
        if so.activity_type:
            counts[so.activity_type] = counts.get(so.activity_type, 0) + 1
    activity = max(counts, key=counts.get) if counts else None

    return key_obs, activity, None, False


# ── Local inference path (Phase 3+) ───────────────────────────────────────────

# ── Activity log ──────────────────────────────────────────────────────────────

# ── Template fallback ──────────────────────────────────────────────────────────

def _template_observations(raw: list[RawObservation]) -> list[KeyObservation]:
    """Deterministic fallback used when no API key is configured or all LLM calls fail."""
    key_obs: list[KeyObservation] = []
    for r in raw:
        text = obs_mod.describe(r.app, r.window_title, r.browser_url, r.file_path)
        if not text:
            continue
        if key_obs and key_obs[-1].text == text:
            continue
        key_obs.append(KeyObservation(timestamp=r.timestamp, text=text))
        if len(key_obs) >= config.MAX_KEY_OBSERVATIONS:
            break
    return key_obs


# ── Deduplication ─────────────────────────────────────────────────────────────

# ── Screenshot lifecycle (Phase 2) ────────────────────────────────────────────

def _delete_all_screenshots(episode: Episode) -> None:
    """
    Delete all temporary screenshot files associated with this episode.

    Phase 2 target: zero persistent raw screenshots.
    Frames are deleted immediately after extraction — they are never moved to
    evidence/ and never uploaded to cloud storage.
    """
    seen: set[str] = set()

    for ev in episode._evidence:
        if ev.screenshot_path and ev.screenshot_path not in seen:
            seen.add(ev.screenshot_path)
            _unlink(ev.screenshot_path)

    for r in episode._raw_observations:
        if r.screenshot_path and r.screenshot_path not in seen:
            seen.add(r.screenshot_path)
            _unlink(r.screenshot_path)


def _unlink(path: str) -> None:
    try:
        Path(path).unlink(missing_ok=True)
    except Exception as e:
        log.debug("finalizer.unlink_failed", path=path, error=str(e))

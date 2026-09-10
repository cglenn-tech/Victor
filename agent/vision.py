"""
Screenshot → Observation batching pipeline.

The agent accumulates ~OBSERVATION_BATCH_SIZE sequential screenshots with
their lightweight metadata (timestamp, active app, window title, URL, file
path, entities), then sends ONE batch to the self-hosted vision model
(OpenAI-compatible, see model_client.py) and gets back ONE structured
observation describing the work performed across the sequence.

There is no cloud path and no on-device fork — the self-hosted endpoint
configured via env vars is the only model. Screenshots are temporary:
they are deleted as soon as their batch is processed (success, retry
exhaustion, or drop). Observations are the durable record.

Reliability:
  - model_client retries transient failures with backoff
  - a batch that fails is retried on later flush triggers, up to
    BATCH_MAX_ATTEMPTS total sends, then dropped (never re-sent)
  - invalid JSON or schema violations → one stricter retry, then drop
  - shallow outputs ("User is using Outlook") are rejected and retried
  - this module never raises into the caller's control flow
"""
import base64
import io
import json
import re
import time
import uuid
from pathlib import Path
from typing import Optional

import config
import model_client
from bh_logging import get_logger
from episode import BatchItem, StructuredObservation

log = get_logger("vision")

BATCH_MAX_ATTEMPTS = 3

REQUIRED_FIELDS = ("title", "observation", "startTime", "endTime", "applications", "entities", "activityType")

ACTIVITY_TYPES = (
    "drafting", "document_review", "research", "communication",
    "coding", "analysis", "administrative", "meeting", "other",
)

_SHALLOW_RE = re.compile(
    r"^(user|the user|person)?\s*(is\s*)?(using|viewing|browsing|looking at|working in)\s+[a-z0-9 .'-]+$",
    re.IGNORECASE,
)


class ObservationBatcher:
    """Collects screenshot items and produces one StructuredObservation per batch."""

    def __init__(self) -> None:
        self._items: list[BatchItem] = []
        self._attempts: int = 0
        self._last_add: float = time.time()

    def __len__(self) -> int:
        return len(self._items)

    def add(self, obs) -> Optional[StructuredObservation]:
        """Queue an Observation with a screenshot. Completes the batch when full."""
        self._items.append(BatchItem(
            screenshot_path=obs.screenshot_path,
            timestamp=obs.timestamp,
            app=obs.app or "",
            window_title=obs.window_title or "",
            browser_url=obs.browser_url or "",
            file_path=obs.file_path or "",
            entities=list(obs.entities or []),
        ))
        self._last_add = time.time()

        if len(self._items) >= config.OBSERVATION_BATCH_SIZE:
            return self.flush(force=True)
        return None

    def flush(self, force: bool = False) -> Optional[StructuredObservation]:
        """
        Analyze the pending batch now.
        force=True: send whatever is queued (session end, app switch, engine close).
        force=False (idle flush): only send if at least MIN_OBSERVATION_BATCH items.
        """
        if not self._items:
            return None
        if not force and len(self._items) < config.MIN_OBSERVATION_BATCH:
            return None

        result = _analyze_batch(self._items)
        self._attempts += 1

        if result is not None:
            self._discard_items()
            self._attempts = 0
            log.info("vision.observation_created", title=result.title, batch_size=len(self._items) + 1)
            return result

        if self._attempts >= BATCH_MAX_ATTEMPTS:
            log.warning("vision.batch_dropped", items=len(self._items), attempts=self._attempts)
            self._discard_items()
            self._attempts = 0
        else:
            log.warning("vision.batch_retry_scheduled", items=len(self._items), attempt=self._attempts)
        return None

    def maybe_idle_flush(self) -> Optional[StructuredObservation]:
        """Flush a partial batch after OBSERVATION_FLUSH_IDLE_SECONDS without new screenshots."""
        if not self._items:
            return None
        idle = time.time() - self._last_add
        if idle >= config.OBSERVATION_FLUSH_IDLE_SECONDS:
            return self.flush(force=False)
        return None

    def _discard_items(self) -> None:
        """Screenshots are temporary — delete them once the batch is processed or dropped."""
        for item in self._items:
            try:
                Path(item.screenshot_path).unlink(missing_ok=True)
            except Exception:
                pass
        self._items.clear()


# ── Batch analysis ────────────────────────────────────────────────────────────

def _analyze_batch(items: list[BatchItem], strict_retry: bool = False) -> Optional[StructuredObservation]:
    """One model request for the whole batch. Returns None on any failure."""
    if not model_client.is_configured():
        return None

    try:
        images = [_prepare_screenshot(i.screenshot_path) for i in items]
    except Exception as e:
        log.error("vision.prepare_failed", error=str(e))
        return None

    prompt = _build_prompt(items, strict_retry)
    content: list[dict] = [{"type": "text", "text": prompt}]
    for jpeg in images:
        b64 = base64.standard_b64encode(jpeg).decode("utf-8")
        if len(b64) > config.VISION_MAX_ENCODED_BYTES:
            log.warning("vision.image_too_large", size=len(b64))
            return None
        content.append({"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}})

    raw = model_client.chat_completion(
        messages=[{"role": "user", "content": content}],
        max_tokens=768,
    )
    if not raw:
        return None

    data = _parse_json(raw)
    if data is None:
        log.warning("vision.invalid_json", strict_retry=strict_retry)
        if not strict_retry:
            return _analyze_batch(items, strict_retry=True)
        return None

    error = _validate(data, items)
    if error:
        log.warning("vision.schema_violation", error=error, strict_retry=strict_retry)
        if not strict_retry:
            return _analyze_batch(items, strict_retry=True)
        return None

    if _is_shallow(data):
        log.warning("vision.shallow_output_rejected", strict_retry=strict_retry)
        if not strict_retry:
            return _analyze_batch(items, strict_retry=True)
        return None

    return StructuredObservation(
        id=str(uuid.uuid4()),
        title=str(data["title"]).strip(),
        observation=str(data["observation"]).strip(),
        start_time=items[0].timestamp,
        end_time=items[-1].timestamp,
        applications=_merge_applications(items, data),
        entities=_clean_list(data.get("entities")),
        activity_type=_clean_activity_type(data.get("activityType")),
    )


def _build_prompt(items: list[BatchItem], strict_retry: bool) -> str:
    metadata = "\n".join(
        f"{i+1}. {item.timestamp} | app: {item.app or 'unknown'}"
        + (f" | title: {item.window_title}" if item.window_title else "")
        + (f" | url: {item.browser_url}" if item.browser_url else "")
        + (f" | file: {item.file_path}" if item.file_path else "")
        + (f" | entities: {', '.join(item.entities[:4])}" if item.entities else "")
        for i, item in enumerate(items)
    )

    prompt = f"""You are VICTOR, a professional work-tracking assistant. You are shown {len(items)} sequential screenshots of one user's screen, taken while they worked.

Screenshots (in chronological order):
{metadata}

Analyze the WHOLE sequence and describe the actual work the user performed.

Respond with ONLY valid JSON matching this exact schema:
{{
  "title": "Short descriptive title of the work (e.g. 'Drafting motion to compel — Peterson v. Ortega')",
  "observation": "2-4 sentences describing the substantive work performed across the sequence: what was being done, on what matter/document, and what progress is visible",
  "startTime": "{items[0].timestamp}",
  "endTime": "{items[-1].timestamp}",
  "applications": ["Applications visible across the sequence"],
  "entities": ["People, cases, projects, clients, companies visible"],
  "activityType": "one of: {', '.join(ACTIVITY_TYPES)}"
}}

Rules:
- The observation must be substantive: describe the actual work performed, not just which app is open.
- NEVER output shallow text like "User is using Outlook" — describe what they were doing in it.
- Use the exact timestamps given above for startTime/endTime.
- Use the metadata to identify applications and entities, verified against what is visible in the screenshots.
- Respond with ONLY the JSON object. No explanation, no markdown fences."""

    if strict_retry:
        prompt += "\n\nIMPORTANT: Your previous response was rejected (invalid JSON, schema violation, or too shallow). Produce a strictly valid JSON object with a SUBSTANTIVE observation describing the actual work performed."

    return prompt


def _parse_json(raw: str) -> Optional[dict]:
    text = raw.strip()
    if text.startswith("```"):
        parts = text.split("```")
        if len(parts) >= 2:
            text = parts[1]
            if text.startswith("json"):
                text = text[4:]
            text = text.strip()
    try:
        parsed = json.loads(text)
    except Exception:
        return None
    return parsed if isinstance(parsed, dict) else None


def _validate(data: dict, items: list[BatchItem]) -> Optional[str]:
    for f in REQUIRED_FIELDS:
        if f not in data:
            return f"missing field '{f}'"
    if not str(data.get("title", "")).strip():
        return "title is empty"
    if not str(data.get("observation", "")).strip():
        return "observation is empty"
    if not isinstance(data.get("applications"), list):
        return "applications must be a list"
    if not isinstance(data.get("entities"), list):
        return "entities must be a list"
    return None


def _is_shallow(data: dict) -> bool:
    observation = str(data.get("observation", "")).strip()
    if len(observation) < 80:
        return True
    return bool(_SHALLOW_RE.match(observation))


def _clean_list(value) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(v).strip() for v in value if str(v).strip()][:20]


def _merge_applications(items: list[BatchItem], data: dict) -> list[str]:
    """Union of model-reported and metadata apps, preserving order."""
    seen: list[str] = []
    for app in _clean_list(data.get("applications")):
        if app.lower() not in [a.lower() for a in seen]:
            seen.append(app)
    for item in items:
        if item.app and item.app.lower() not in [a.lower() for a in seen]:
            seen.append(item.app)
    return seen[:10]


def _clean_activity_type(value) -> str:
    v = str(value or "").strip()
    if v in ACTIVITY_TYPES:
        return v
    lowered = v.lower()
    for known in ACTIVITY_TYPES:
        if known in lowered:
            return known
    return "other"


def _prepare_screenshot(path: str) -> bytes:
    """
    Read, resize, and JPEG-compress a screenshot for the vision request.
    Full-resolution raw images are never sent to the model.
    """
    from PIL import Image

    img = Image.open(path)

    if img.mode not in ("RGB", "L"):
        img = img.convert("RGB")

    max_w, max_h = config.VISION_ANALYSIS_SIZE
    if img.width > max_w or img.height > max_h:
        img.thumbnail((max_w, max_h), Image.LANCZOS)

    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=config.VISION_JPEG_QUALITY, optimize=True)
    return buf.getvalue()

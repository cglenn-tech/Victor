"""
Self-hosted model client — the ONLY model caller in the agent.

OpenAI-compatible chat completions endpoint, fully configured via
environment variables (see config.py):
    SELF_HOSTED_MODEL_URL    base URL, e.g. https://<pod>.runpod.ai/v2/<id>/openai/v1
    SELF_HOSTED_MODEL_NAME   model id served by the endpoint
    SELF_HOSTED_API_KEY      bearer token

There is no cloud path and no local/on-device fork — the entire product
is private. Swapping backends only requires changing these env vars.

Reliability:
  - Retries with exponential backoff on network errors, timeouts, 429 and 5xx.
  - Never raises into the caller's control flow for transient problems:
    callers get None and the loop keeps running.
  - Logs error types only — never screenshot contents or model payloads.
"""
import json
import time
import urllib.error
import urllib.request
from typing import Optional

import config
from bh_logging import get_logger

log = get_logger("model_client")


class ModelNotConfiguredError(RuntimeError):
    """Raised when the self-hosted endpoint is not configured via env."""


def is_configured() -> bool:
    return bool(config.SELF_HOSTED_MODEL_URL and config.SELF_HOSTED_MODEL_NAME and config.SELF_HOSTED_API_KEY)


def chat_completion(
    messages: list[dict],
    max_tokens: int = 1024,
    temperature: float = 0.2,
) -> Optional[str]:
    """
    Send one chat completion request. Returns assistant text, or None on any
    failure after retries. Never raises for transient errors.
    """
    if not is_configured():
        log.warning("model_client.not_configured")
        return None

    url = config.SELF_HOSTED_MODEL_URL.rstrip("/") + "/chat/completions"
    payload = json.dumps({
        "model": config.SELF_HOSTED_MODEL_NAME,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
    }).encode()

    last_error = ""
    for attempt in range(config.MODEL_MAX_RETRIES + 1):
        if attempt > 0:
            backoff = min(2 ** attempt, 30) + (attempt * 0.5)
            time.sleep(backoff)

        req = urllib.request.Request(
            url,
            data=payload,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {config.SELF_HOSTED_API_KEY}",
            },
            method="POST",
        )

        try:
            with urllib.request.urlopen(req, timeout=config.MODEL_TIMEOUT_SECONDS) as resp:
                result = json.loads(resp.read())
            content = result["choices"][0]["message"]["content"]
            if isinstance(content, list):
                content = "".join(part.get("text", "") for part in content)
            text = (content or "").strip()
            if not text:
                log.warning("model_client.empty_content", attempt=attempt + 1)
                continue
            return text
        except urllib.error.HTTPError as e:
            last_error = f"http_{e.code}"
            retryable = e.code == 429 or e.code >= 500
            log.warning(
                "model_client.http_error",
                attempt=attempt + 1,
                status=e.code,
                retryable=retryable,
            )
            if not retryable:
                return None
        except Exception as e:
            last_error = type(e).__name__
            log.warning("model_client.request_failed", attempt=attempt + 1, error=last_error)

    log.error("model_client.gave_up", attempts=config.MODEL_MAX_RETRIES + 1, last_error=last_error)
    return None

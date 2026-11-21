"""Provider-agnostic LLM client over httpx: OpenAI-compatible
chat/completions at LLM_BASE_URL (e.g. a free local Ollama at
http://ollama:11434/v1) with LLM_API_KEY/LLM_MODEL from env; one request
(60s timeout) + exactly one retry on transport error. No provider SDKs, no
hardcoded endpoints, models or prices. ModelNotConfigured when key, model
or base URL is unset — the caller treats that as package-only mode.

LLM_PROVIDER=deterministic selects the offline template provider
(deterministic.py) instead: no HTTP at all.

Interface seam: call_model(prompt, package_json, transport=None) — tests
inject a transport, never a live provider.
"""
from __future__ import annotations

import os
from typing import Optional

import httpx


DETERMINISTIC = "deterministic"


def provider() -> str:
    return (os.getenv("LLM_PROVIDER") or "openai_compatible").strip().lower()


def model_configured() -> bool:
    """True when finish_investigation would produce a report (not awaiting_model)."""
    if provider() == DETERMINISTIC:
        return True
    return bool(os.getenv("LLM_API_KEY") and os.getenv("LLM_MODEL") and os.getenv("LLM_BASE_URL"))


class ModelNotConfigured(Exception):
    pass


class ModelError(Exception):
    pass


def call_model(
    prompt: str,
    package_json: str,
    transport: Optional[httpx.BaseTransport] = None,
    model: Optional[str] = None,
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
) -> dict:
    """Returns {"content": str, "input_tokens": int|None, "output_tokens": int|None, "model": str}."""
    key = api_key if api_key is not None else os.getenv("LLM_API_KEY")
    mdl = model if model is not None else os.getenv("LLM_MODEL")
    if not key:
        raise ModelNotConfigured("LLM_API_KEY unset")
    if not mdl:
        raise ModelNotConfigured("LLM_MODEL unset")
    base = base_url if base_url is not None else os.getenv("LLM_BASE_URL")
    if not base:
        raise ModelNotConfigured("LLM_BASE_URL unset")
    url = base.rstrip("/") + "/chat/completions"

    body = {
        "model": mdl,
        "messages": [
            {"role": "system", "content": prompt},
            {"role": "user", "content": package_json},
        ],
    }
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    last_err: Exception | None = None
    with httpx.Client(transport=transport, timeout=60) as client:
        for _attempt in range(2):  # one try + exactly one retry
            try:
                r = client.post(url, json=body, headers=headers)
                r.raise_for_status()
                data = r.json()
                usage = data.get("usage") or {}
                choice = (data.get("choices") or [{}])[0]
                return {
                    "content": choice.get("message", {}).get("content", ""),
                    "input_tokens": usage.get("prompt_tokens"),
                    "output_tokens": usage.get("completion_tokens"),
                    "model": mdl,
                }
            except httpx.TransportError as e:
                last_err = e
                continue
            except httpx.HTTPStatusError as e:
                raise ModelError(f"provider error {e.response.status_code}") from e
    raise ModelError(f"transport failed after retry: {last_err}")

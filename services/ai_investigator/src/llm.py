"""Provider-agnostic LLM client over httpx: LLM_API_KEY/LLM_MODEL from env,
one request (60s timeout) + exactly one retry on transport error. No
provider SDKs, no hardcoded models or prices. ModelNotConfigured when no
key — the caller treats that as package-only mode.

Interface seam: call_model(prompt, package_json, transport=None) — tests
inject a transport, never a live provider.
"""
from __future__ import annotations

import os
from typing import Optional

import httpx


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
) -> dict:
    """Returns {"content": str, "input_tokens": int|None, "output_tokens": int|None, "model": str}."""
    key = api_key if api_key is not None else os.getenv("LLM_API_KEY")
    mdl = model if model is not None else os.getenv("LLM_MODEL")
    if not key:
        raise ModelNotConfigured("LLM_API_KEY unset")
    if not mdl:
        raise ModelNotConfigured("LLM_MODEL unset")

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
                r = client.post("https://llm.invalid/v1/chat/completions", json=body, headers=headers)
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

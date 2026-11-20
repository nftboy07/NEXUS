"""Token usage + cost estimate. Prices come ONLY from
LLM_PRICE_INPUT_PER_MTOK / LLM_PRICE_OUTPUT_PER_MTOK env; absent -> NULL."""
from __future__ import annotations

import os


def cost_estimate(input_tokens: int | None, output_tokens: int | None) -> float | None:
    pi = os.getenv("LLM_PRICE_INPUT_PER_MTOK")
    po = os.getenv("LLM_PRICE_OUTPUT_PER_MTOK")
    if pi is None or po is None or input_tokens is None or output_tokens is None:
        return None
    return input_tokens * float(pi) / 1e6 + output_tokens * float(po) / 1e6

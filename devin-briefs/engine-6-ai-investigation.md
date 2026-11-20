# Devin Brief — Engine 6: AI Investigation Agent

You are building **Engine 6 of NEXUS** in the GitHub repo **nftboy07/NEXUS** (branch off `main`). This brief is self-contained: everything you need is below or in the repo files it names.

## Project context (read first, in this order)

NEXUS — Autonomous Blockchain Intelligence Network, by **Crypto Relic**. Core principle: **deterministic software detects and processes blockchain events; AI investigates selected, enriched events only. AI must never sit in the critical path of event ingestion** — the listener and every other engine keep working if this service, or the LLM provider, is down. This engine is the *only* place in NEXUS where an LLM may be called.

Read these repo files before writing code:

- `README.md`
- `docs/BLUEPRINT.md` — §8 (Engine 6: stages A/B/C, report requirements, workflow)
- `docs/BUILD_SPEC.md` — binding build rules for all agents
- `docs/architecture.md`
- `docs/database.md` and `migrations/001_init.sql` — the `investigations` table already exists
- `docs/roadmap.md` — Phase 6 acceptance criteria
- `services/ai_investigator/PROMPT.md` — **the existing investigation prompt; it is binding.** Implement against it. You may extend it only to add output-format instructions for the schema below; you may not weaken any of its rules.
- `packages/event_schemas/event.schema.json`, `packages/chain_config/chains.json`, `.env.example` (note `LLM_API_KEY`, `LLM_MODEL`)
- **Dependencies (read their service dirs):** Engine 1 (stored blocks/txs/logs/transfers in Postgres), Engine 3 (`services/wallet_intelligence/` — profiles, scores, relation hypotheses used as enrichment). If Engine 3 has not merged yet, build the evidence package from Engine 1 tables alone and mark enrichment sections absent — never fabricate them.

**Stack:** Python 3.12 · PostgreSQL 16. Triggered manually (CLI) in the MVP — no daemon, no automatic firing on raw events.

**Shared contracts you must honor:**

- Investigation records live in the `investigations` table (extended by your migration).
- **Migration number assigned to this engine: `migrations/006_investigations_detail.sql`.** Never edit `001_init.sql`; never use another engine's number.

## Standing rails (non-negotiable)

- **$0 spend in development and tests.** Tests must never call a live LLM — use recorded stub responses. Runtime LLM use is the owner's configured provider only (`LLM_API_KEY` / `LLM_MODEL` env vars); the AI budget line is $35 of a $200 prototype budget (see `docs/BUDGET.md`), so every investigation records its token usage and cost estimate.
- **No secrets in code, logs, or prompts.** The API key comes from env only and must never appear in an evidence package, a prompt, a log line, or a stored report. **No private keys anywhere** — this service has read-only tools only, no signing capability of any kind.
- **AI honesty rules (from `PROMPT.md` + BLUEPRINT §8):** never invent blockchain activity; never describe correlation as proof of common ownership; every report distinguishes observed facts, estimates, and hypotheses; every cited tx hash and block number must exist in the evidence package — this is enforced mechanically by the validator below, not left to the model.
- **Failure is a normal state.** No key configured, provider timeout, or malformed model output → the investigation is stored with an explicit status and the rest of NEXUS is unaffected. This service is never imported by ingestion code.
- **Brand:** user-facing strings say "Crypto Relic" / "NEXUS by Crypto Relic" only.
- **Small reviewable PR.** Branch `devin/engine-6-ai-investigation` off `main`. Do not edit `docs/BLUEPRINT.md` or `migrations/001_init.sql`. Do not merge your own PR. Report implemented vs planned honestly, with test commands and output.
- **Definition of done (BUILD_SPEC):** code + tests pass; typed schemas (pydantic) for both the evidence package and the report; structured logging; no mock data in production paths (stubs live in tests only).

## Engine goal

Given a trigger (a tx hash, in the MVP), assemble a structured evidence package deterministically from stored data (Stage B enrichment), call the configured LLM with `PROMPT.md` + the package (Stage C), validate the returned report mechanically — every citation must exist in the package — and store the report with confidence, alternative explanations, missing evidence, token usage, and cost (roadmap Phase 6 acceptance: *AI reports never present unsupported claims as verified facts*).

## Exact deliverables

### `services/ai_investigator/` (new Python package)

- `requirements.txt` — `psycopg[binary]`, `pydantic`, `httpx`, `pytest`.
- `src/evidence_schema.py` — pydantic `EvidencePackage`: trigger (tx hash, chain, block), transaction + block records, wallet history summaries for involved addresses (from Engine 1 tables; Engine 3 profile/score/hypotheses when present, each with provenance), related transfers + contracts, labels **with their sources**, liquidity context where relevant, and a `citable` index: the exact set of `(tx_hash, block_number)` pairs the report is allowed to cite.
- `src/package.py` — build an `EvidencePackage` from Postgres for a given `(chain_id, tx_hash)`. Everything in the package comes from stored rows; anything not found is listed under `missing` in the package, never filled in.
- `src/report_schema.py` — pydantic `InvestigationReport`: `findings[]` (each tagged `fact | estimate | hypothesis`), `citations[]` (`tx_hash`, `block_number`), `confidence` (`level`, `rationale`), `alternative_explanations[]`, `missing_evidence[]`, `next_steps[]`. A report that fails this schema is not stored as a report — it is stored as a failed run with the raw output preserved for debugging (raw output never contains the API key; assert this).
- `src/llm.py` — provider-agnostic client over `httpx`: reads `LLM_API_KEY` / `LLM_MODEL` from env; one request with a bounded timeout (60s) and exactly one retry on transport error. If the key is unset, raise a typed `ModelNotConfigured` — the caller handles it as package-only mode (below). No provider SDKs, no hardcoded model names or prices.
- `src/validate.py` — the citation validator: every `citations[]` entry must be in the package's `citable` index; findings tagged `fact` must carry at least one valid citation. Output: `validation_pass: bool` + the list of unsupported citations/claims. This module is pure and deterministic — it is the mechanical enforcement of the honesty rules.
- `src/cost.py` — record `input_tokens` / `output_tokens` from the provider response; cost estimate only when per-token prices are supplied via env (`LLM_PRICE_INPUT_PER_MTOK`, `LLM_PRICE_OUTPUT_PER_MTOK`) — otherwise store `cost_estimate = NULL` (unknown), never an invented price.
- `src/investigate.py` — orchestration: build package → insert `investigations` row (`status = 'package_built'`) → if no model configured, finish with `status = 'awaiting_model'` and exit 0 → else call LLM with `PROMPT.md` + package JSON → parse against `InvestigationReport` → validate → store report + validation result with `status = 'complete' | 'validation_failed'`. A `validation_failed` report is stored for audit but must be clearly marked and is never presented as verified.
- `src/main.py` — CLI: `python -m ai_investigator --chain 1 --tx 0x…` (also accept `--address` to investigate a wallet's recent activity using the same pipeline). Manual trigger only.
- `migrations/006_investigations_detail.sql` — `ALTER TABLE investigations ADD COLUMN IF NOT EXISTS report JSONB, ADD COLUMN IF NOT EXISTS citations_valid BOOLEAN, ADD COLUMN IF NOT EXISTS input_tokens INTEGER, ADD COLUMN IF NOT EXISTS output_tokens INTEGER, ADD COLUMN IF NOT EXISTS cost_estimate NUMERIC, ADD COLUMN IF NOT EXISTS model TEXT, ADD COLUMN IF NOT EXISTS chain_id INTEGER, ADD COLUMN IF NOT EXISTS trigger_tx TEXT`.
- Replace `services/ai_investigator/README.md` stub with real docs: how to trigger, package-only mode, the validation gate, cost recording.

### Tests (`services/ai_investigator/tests/`, pytest) — no live LLM calls

- `fixtures/` — a fixture evidence package (built from labeled fixture DB rows) + recorded stub model responses: one well-formed report, one report citing an **invented** tx hash, one malformed (schema-invalid) response.
- `test_validate.py` — the well-formed stub passes; the invented-citation stub fails validation with the fabricated hash named; a `fact` finding with no citation fails.
- `test_package.py` — package built from fixture rows contains exactly the stored evidence; a lookup for a missing tx lists it under `missing` and cites nothing.
- `test_no_key_mode.py` — with `LLM_API_KEY` unset, a run completes in package-only mode with `status = 'awaiting_model'` and makes zero HTTP calls (assert via a transport mock).
- `test_secrets.py` — run the full pipeline with a dummy key in env; assert the key string appears in no stored field, log record, or serialized package/report.

## Acceptance checks (all must pass; paste output in the PR)

```bash
cd services/ai_investigator
pip install -r requirements.txt
pytest
```

Plus a CLI demonstration against fixture data in local Postgres (from `docker-compose.yml`) using the stubbed responses, showing all three outcomes stored correctly: `complete` (valid report), `validation_failed` (fabricated citation), and `awaiting_model` (no key). Print the three `investigations` rows' `status` + `citations_valid` in the PR description.

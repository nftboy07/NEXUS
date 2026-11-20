# Devin Brief — Engine 7: Alerts & Optional Execution

You are building **Engine 7 of NEXUS** in the GitHub repo **nftboy07/NEXUS**. It lands as **two sequential PRs** (PR-A, then PR-B off the merged PR-A). This brief is self-contained: everything you need is below or in the repo files it names.

## Project context (read first, in this order)

NEXUS — Autonomous Blockchain Intelligence Network, by **Crypto Relic**. Deterministic software detects and processes on-chain events; AI investigates selected, enriched events only (Engine 6). Every alert must trace to tx hashes, block numbers, contract addresses, and timestamps.

Read these repo files before writing code:

- `README.md`
- `docs/BLUEPRINT.md` — §9 (Engine 7: channels, alert format, execution safeguards)
- `docs/BUILD_SPEC.md` — binding build rules for all agents
- `docs/architecture.md`
- `docs/database.md` and `migrations/001_init.sql` — `alerts`, `watchlists`, `investigations`, `checkpoints`, `provider_health` tables already exist
- `docs/roadmap.md` — Phase 7 acceptance criteria
- `apps/api/main.py` — the existing FastAPI skeleton (`/health`, `/chains`) you are extending
- `packages/event_schemas/event.schema.json`, `packages/chain_config/chains.json`, `.env.example` (note `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `DISCORD_WEBHOOK_URL`)
- **Dependencies:** Engines 1–6 publish alert records to Redis stream `nexus:alerts` and rows to the `alerts` table — that stream + table are your input. If some producer engines have not merged yet, build against the alert contract below with fixtures and say so in your PR description.

**Stack:** Python 3.12 + FastAPI (API + dispatcher) · Next.js (dashboard, PR-B) · PostgreSQL 16 · Redis Streams · Docker Compose.

**Alert record contract (input):** JSON on `nexus:alerts` with `source_engine`, `kind`, `chain_id`, `title`, `facts{}` (tx hashes, block numbers, addresses, amounts), optional `assessment{confidence, alternatives[], missing_info[]}`, `dedup_key`, `created_at`. PR-A's first deliverable pins this as a schema file so producers and this engine agree.

## Standing rails (non-negotiable)

- **$0 spend.** No paid notification services. Telegram/Discord use the owner's bot token / webhook URL from env only.
- **No secrets in code.** Tokens and keys from env vars only; the API key is compared as a hash, never logged, never returned in a response.
- **Deterministic only.** No LLM calls in this engine — formatting is templates, delivery is rules.
- **Brand:** every user-facing message and page says "Crypto Relic" / "NEXUS by Crypto Relic" only. Telegram/Discord messages carry the NEXUS name.
- **Execution: DO NOT BUILD IT.** The MVP is read-only monitoring. There must be **no** signing code, no private-key handling, no transaction submission anywhere in either PR. The execution layer's only deliverable is a design document (below) describing the future safeguards — simulation, allowlists, spend limits, human approval, kill switch — as *not implemented*.
- **Facts and assessment stay separate** in every message (BLUEPRINT §9 format): observed facts in one section, assessment (confidence, alternatives, missing info) in another. Mempool-sourced alerts must show status `PENDING` prominently and never read as confirmed.
- **Small reviewable PRs.** Branches `devin/engine-7-alerts-api` (PR-A) and `devin/engine-7-dashboard` (PR-B). Do not edit `docs/BLUEPRINT.md` or `migrations/001_init.sql`. Do not merge your own PRs. Report implemented vs planned honestly, with test commands and output.
- **Definition of done (BUILD_SPEC):** code + tests pass; typed schemas; structured logging; idempotent delivery (the same alert is never delivered twice); no mock data in production paths (HTTP mocks live in tests only).

## Engine goal

Deliver evidence-backed alerts from Engines 2–5 to Telegram, Discord, and signed webhooks — formatted per BLUEPRINT §9, deduplicated, with tracked delivery state and bounded retries — and expose the platform through the REST API (watchlists, alerts, investigations, wallet profiles, system health) plus a minimal dashboard (roadmap Phase 7 acceptance: *a user can configure a watchlist, receive an alert, open the evidence, and inspect the investigation*).

## PR-A deliverables — dispatcher + API (`devin/engine-7-alerts-api`)

### Contract

- `packages/event_schemas/alert.schema.json` — JSON Schema for the alert record contract above; producers and dispatcher both validate against it.

### `services/alert_dispatcher/` (new Python package)

- `requirements.txt` — `redis`, `psycopg[binary]`, `pydantic`, `httpx`, `pytest`.
- `src/models.py` — pydantic `AlertRecord` matching `alert.schema.json`.
- `src/consumer.py` — Redis consumer group on `nexus:alerts`; validate each record against the schema (invalid records → log + park, never crash the loop); ack after delivery processing completes.
- `src/format.py` — message formatter implementing BLUEPRINT §9 exactly: header (network, event kind, status — `PENDING` when the source is the mempool engine), **Facts** section (wallet, token, amounts, tx hash, block, timestamps, evidence/explorer-ready references), **Assessment** section (confidence, risk indicators, alternative explanations, missing info) — rendered only from fields present in the record; absent assessment → the section says "No assessment supplied", it is never invented.
- `src/channels/telegram.py` — Bot API `sendMessage` using `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` from env. Token unset → channel runs in log-only mode (message written to structured log, delivery marked `skipped_no_config`), never an exception that stops the dispatcher.
- `src/channels/discord.py` — POST to `DISCORD_WEBHOOK_URL` from env; same log-only degradation when unset.
- `src/channels/webhook.py` — POST the alert JSON to URLs from env `ALERT_WEBHOOK_URLS` (comma-separated), with an `X-Nexus-Signature: sha256=<hmac>` header computed with env `WEBHOOK_SECRET`; unset secret → webhooks disabled with a log line (never send unsigned).
- `src/delivery.py` — delivery state machine on the `alerts` table: `pending → sent | failed | skipped_no_config`; bounded retries (max 3, exponential backoff) on transport errors only; **dedup by `dedup_key`** — a record whose `dedup_key` already has a `sent` row is acked without redelivery.
- `src/main.py` — dispatcher entrypoint; structured logging; one channel's failure never blocks the others.
- Replace `services/alert_dispatcher/README.md` stub with real setup/run docs.

### `apps/api/` (extend the existing FastAPI skeleton)

- `requirements.txt` — add `psycopg[binary]`, `redis`, `pydantic`, `httpx` + `pytest` for tests.
- Auth: every endpoint except `/health` requires header `X-API-Key` matching env `NEXUS_API_KEY` (add to `.env.example`, placeholder only); compare via hash; missing/wrong key → 401.
- Endpoints:
  - `GET /health` — extended: per-chain last checkpoint block + lag, latest `provider_health` per provider/chain, queue depth of `nexus:events` / `nexus:alerts`.
  - `POST /watchlists`, `GET /watchlists`, `DELETE /watchlists/{id}` — CRUD over the `watchlists` table (kind `wallet | contract`, value, note).
  - `GET /alerts` — paginated alert history with delivery state; `GET /alerts/{id}`.
  - `GET /investigations`, `GET /investigations/{id}` — read Engine 6's stored reports, including `citations_valid` and status (a `validation_failed` report must be visibly marked as unverified in the response).
  - `GET /wallets/{address}` — Engine 3's profile + latest score (404 with a clear message when the wallet is unknown; never fabricate a profile).
  - `GET /chains` — keep the existing endpoint, now driven by `packages/chain_config/chains.json`.
- `apps/telegram_bot/` — minimal bot (stretch within PR-A; include only if the dispatcher + API are complete and tested): long-poll bot with `/watch <address>`, `/unwatch <address>`, `/alerts` writing/reading the same `watchlists`/`alerts` tables. If included, replace its README stub; if not, say so in the PR description.
- `docs/execution-safeguards.md` — design-only document for the future execution layer: simulation before any action, address allowlists, max value + max slippage limits, manual approval for high-risk actions, kill switch, separate execution wallet, full audit logs — each marked **NOT IMPLEMENTED in the MVP**, plus the rule that no private key may ever appear in code, logs, prompts, or AI context.
- `.env.example` — append `NEXUS_API_KEY=`, `ALERT_WEBHOOK_URLS=`, `WEBHOOK_SECRET=`, `EXECUTION_ENABLED=false` (the flag exists so the disabled state is explicit; no code path may act on it in this PR).

### Tests (`services/alert_dispatcher/tests/` + `apps/api/tests/`, pytest)

- `test_format.py` — a whale alert record renders with Facts and Assessment separated and all evidence fields present; a mempool record renders with `PENDING` in the header; a record without assessment renders "No assessment supplied".
- `test_delivery.py` — same `dedup_key` delivered twice → one send; transport failure → retries bounded at 3 → state `failed`; Telegram unconfigured → `skipped_no_config`, loop continues.
- `test_webhook_signature.py` — HMAC header verifies against the secret; wrong secret fails verification.
- `test_api.py` — FastAPI TestClient: 401 without key; watchlist create→list→delete round-trip; `/wallets/{unknown}` → 404; `/health` returns per-chain checkpoints from fixture rows.
- End-to-end test: publish a fixture alert record to `nexus:alerts` (local Redis) → dispatcher with Telegram HTTP mocked → exactly one correctly formatted message sent and the `alerts` row ends `sent`.

## PR-B deliverables — dashboard (`devin/engine-7-dashboard`, after PR-A merges)

### `apps/dashboard/` (Next.js app, replacing the README stub)

- Scaffold a minimal Next.js (App Router, TypeScript) app in `apps/dashboard/`; the API base URL + key come from server-side env (`NEXUS_API_URL`, `NEXUS_API_KEY`) — the key is never shipped to the browser.
- Pages (only these four in this PR): **Overview** (per-chain health, checkpoint lag, alert counts), **Live Feed** (recent alerts + recent events from the API, auto-refresh), **Alerts** (history with delivery state; opening an alert shows its evidence fields), **Watchlists** (list + add/remove via the API).
- Replace `apps/dashboard/README.md` with setup/run docs. State plainly in the PR which of the 12 planned dashboard pages (BLUEPRINT §15) are *not* in this PR: Mempool, Wallet Intelligence, Whale Radar, DEX Radar, MEV Monitor, AI Investigations, System Health, Settings are follow-ups.

### Tests

- `npm run build` passes; a smoke test or documented manual check that each of the four pages renders against the local API seeded with fixture rows (screenshots in the PR description).

## Acceptance checks (paste output in each PR)

PR-A:

```bash
cd services/alert_dispatcher && pip install -r requirements.txt && pytest
cd apps/api && pip install -r requirements.txt && pytest
grep -rn "private_key\|sign_transaction\|send_transaction" services/alert_dispatcher apps/api apps/telegram_bot || true   # must return nothing
```

Plus the end-to-end fixture run (local Postgres + Redis from `docker-compose.yml`) with the single delivered message shown in the PR description.

PR-B:

```bash
cd apps/dashboard && npm install && npm run build
```

Plus screenshots of the four pages running against the local API.

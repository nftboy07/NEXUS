# Devin Brief — Engine 1: Multi-Chain RPC Listener Network

You are building **Engine 1 of NEXUS** in the GitHub repo **nftboy07/NEXUS** (branch off `main`). This brief is self-contained: everything you need is below or in the repo files it names.

## Project context (read first, in this order)

NEXUS — Autonomous Blockchain Intelligence Network, by **Crypto Relic**. A continuously running, multi-chain EVM intelligence platform: deterministic software detects and processes on-chain events; AI investigates selected, enriched events only (that is Engine 6, not this one). Every finding must trace to tx hashes, block numbers, contract addresses, and timestamps.

Read these repo files before writing code:

- `README.md`
- `docs/BLUEPRINT.md` — §3 (Engine 1) and §12 (starter listener)
- `docs/BUILD_SPEC.md` — binding build rules for all agents
- `docs/architecture.md` — data flow, failover, reorg handling
- `docs/database.md` and `migrations/001_init.sql` — schema of record
- `docs/roadmap.md` — Phase 1 and Phase 2 acceptance criteria (this engine covers both)
- `packages/event_schemas/event.schema.json` — the normalized event contract
- `packages/chain_config/chains.json` — chain config of record
- `.env.example` — every config value comes from env vars listed here
- `services/evm_listener/src/listener.ts` — the existing starter you are replacing (real viem ERC-20 Transfer listener; confirmed events only; no storage, backfill, reconnect, reorg, or multi-chain yet)

**Stack:** TypeScript + viem (listeners) · Python + FastAPI (API) · PostgreSQL 16 · Redis Streams · Docker Compose (`docker-compose.yml` already defines `postgres`, `redis`, `api`).

**Chains:** Ethereum (`chain_id` 1) and Base (8453) are live targets. Arbitrum (42161) and BSC (56) are `"planned": true` in `chains.json` — everything chain-specific must be config-driven from that file, never hardcoded.

**Shared contracts you must honor:**

- Normalized events match `packages/event_schemas/event.schema.json` (`NexusNormalizedEvent`; `dedup_key` = `chain_id:block_hash:tx_hash:log_index` for logs).
- Redis Streams: `nexus:events` (normalized confirmed events — you are the producer), `nexus:pending` (Engine 2), `nexus:alerts` (alert producers → Engine 7).
- Log identity in Postgres: `(chain_id, block_hash, transaction_hash, log_index)` — inserts must be idempotent upserts against the primary keys in `migrations/001_init.sql`.

## Standing rails (non-negotiable)

- **$0 spend.** Do not sign up for, provision, or call any paid service. Dev/test runs use free public RPC endpoints or recorded fixtures only. Never commit a `.env` file or a real keyed endpoint URL.
- **No secrets in code.** No API keys, tokens, passwords, or private keys in code, tests, fixtures, logs, or comments. Env vars only. Read-only monitoring: no signing, no transaction submission, no trading — anywhere in this PR.
- **Deterministic only.** No LLM calls in this engine. It must work fully with no AI configured anywhere.
- **Brand:** user-facing strings and docs say "Crypto Relic" / "NEXUS by Crypto Relic" only.
- **Evidence or it didn't happen.** Never invent transaction data. Label facts, estimates, and hypotheses distinctly.
- **Small reviewable PR.** Branch `devin/engine-1-rpc-listener` off `main`. Do not edit `docs/BLUEPRINT.md` (canonical) or `migrations/001_init.sql` (already applied). Do not merge your own PR — the owner reviews and merges. In the PR description, report implemented vs planned honestly, with the test commands you ran and their output.
- **Definition of done (BUILD_SPEC):** code + tests exist and pass; typed schemas; structured logging; bounded exponential-backoff retries; idempotent processing; fixtures for duplicates and reorgs; no mock data in production paths; never silently replace a WebSocket subscription with polling.

## Engine goal

Turn the starter listener into the production ingestion foundation for all other engines: per-chain WebSocket subscriptions (new heads + logs) with durable Postgres storage, per-chain checkpoints, HTTP backfill after any gap, primary→secondary provider failover, reorg handling, provider health metrics, and normalized events published to Redis Streams. Restarting the service must never silently skip events, and redelivery must never create duplicates (roadmap Phase 1–2 acceptance).

## Exact deliverables

### Repo plumbing (foundation for Engines 2 and 4, which are also TypeScript)

- Root `package.json` with npm workspaces: `services/*`, `packages/*`.
- `packages/event_schemas/types.ts` — TypeScript types matching `event.schema.json` exactly, exported as `@nexus/event-schemas`.
- `packages/shared_utils/` as a real TS package `@nexus/shared-utils`: `src/backoff.ts` (bounded exponential backoff with jitter + max attempts), `src/dedup.ts` (dedup-key builder/parser), `src/log.ts` (structured JSON logger). Unit tests included.
- `packages/chain_config/log_filters.json` — config-driven log subscription filters (contract addresses + event signatures), seeded with the ERC-20 `Transfer` filter from the starter. Engines 4/5 extend this file later; the listener must read its subscriptions from here, not from hardcoded constants.

### `services/evm_listener/` (rewrite; keep package name `@nexus/evm-listener`)

- `package.json` — add deps `pg`, `redis`; dev dep `vitest`; scripts `start`, `typecheck`, `test`.
- `src/config.ts` — loads `packages/chain_config/chains.json`; resolves each chain's `wss_env` / `http_env` env vars; supports an optional secondary provider via `<ENV_NAME>_SECONDARY` env vars; skips `"planned": true` chains; fails loudly on missing primary env.
- `src/rpc.ts` — viem public clients (WebSocket + HTTP) per chain, primary and secondary.
- `src/subscriptions.ts` — `watchBlocks` + log watchers built from `log_filters.json`; heartbeat/last-message tracking per subscription.
- `src/store.ts` — Postgres writes for `blocks`, `logs`, `transactions`: `ON CONFLICT DO NOTHING` upserts keyed on the `001_init.sql` primary keys; `markLogsRemoved(chainId, blockHash)` for reorgs.
- `src/checkpoint.ts` — read/write `checkpoints` table per chain (last processed block + log cursor); a block's checkpoint advances only after its events are stored **and** published.
- `src/backfill.ts` — on startup and after any reconnect: `eth_getLogs` + block fetch for `(checkpoint, currentHead]` in bounded block-range chunks (chunk size configurable, default 2000), dedup via store upserts, then resume live subscriptions.
- `src/failover.ts` — on WS error/heartbeat timeout: bounded backoff reconnect → switch to secondary provider → backfill from checkpoint → resubscribe → record the outage in `provider_health`.
- `src/reorg.ts` — track block hash + parent hash; within each chain's `confirmations` depth (from `chains.json`), verify parent linkage on each new head; on mismatch, walk back to the common ancestor, mark affected logs `removed = TRUE`, rewind the checkpoint, and let backfill reprocess the canonical range.
- `src/publisher.ts` — `XADD` each normalized event to Redis stream `nexus:events`.
- `src/health.ts` — periodic `provider_health` rows (provider, chain, latency ms, error count) + reconnect counters; structured JSON logs for lag, backfill progress, duplicates suppressed.
- `src/listener.ts` — thin orchestrator: one isolated instance per enabled chain (one chain failing must not stop the others), graceful shutdown on SIGTERM.
- `docker-compose.yml` — add an `evm_listener` service (build from `services/evm_listener`, env from `.env`, depends on postgres + redis).
- `.env.example` — append the secondary-provider vars (`WSS_RPC_URL_SECONDARY`, `HTTP_RPC_URL_SECONDARY`, `WSS_RPC_URL_BASE_SECONDARY`, `HTTP_RPC_URL_BASE_SECONDARY`) and `LOG_LEVEL`. Placeholder values only.

### Tests (`services/evm_listener/tests/`, vitest)

- `dedup.test.ts` — same log delivered twice → one stored row, one published event.
- `normalize.test.ts` — raw viem log/block → `NexusNormalizedEvent` matching the JSON schema, correct `dedup_key`.
- `backfill.test.ts` — chunked range computation; resume from a checkpoint fills exactly the missing range.
- `reorg.test.ts` — recorded fixture chain with a fork: non-canonical logs end up `removed = TRUE`, checkpoint rewinds, canonical replacements are stored.
- `fixtures/` — recorded blocks/logs JSON used by the tests (real structure, no invented hashes presented as real — label fixture provenance in a `fixtures/README.md`).
- Update `services/evm_listener/README.md` (create if absent) and replace any "Planned service" stub text with real setup/run/recovery docs.

## Acceptance checks (all must pass; paste output in the PR)

```bash
cd services/evm_listener
npm install
npm run typecheck
npm test
```

Plus, with local infra up (`docker compose up -d postgres redis`) and a local, uncommitted `.env` pointing `WSS_RPC_URL` at any free public Ethereum WebSocket endpoint:

1. `npm start` — blocks and logs land in Postgres; the `checkpoints` row advances.
2. Kill the process mid-stream, wait ~1 minute, restart — backfill fills the gap; a SQL count in the PR description proves zero duplicate `(chain_id, block_hash, transaction_hash, log_index)` rows.
3. With Base also configured, stop one chain's endpoint (point its env var at a dead URL in a scratch run) — the other chain keeps ingesting.

If a live smoke run is impossible in your environment, say so in the PR and make sure the fixture-based tests cover the same three behaviors — do not claim a smoke run you did not do.

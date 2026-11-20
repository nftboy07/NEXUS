# Devin Brief — Engine 2: Mempool Intelligence

You are building **Engine 2 of NEXUS** in the GitHub repo **nftboy07/NEXUS** (branch off `main`). This brief is self-contained: everything you need is below or in the repo files it names.

## Project context (read first, in this order)

NEXUS — Autonomous Blockchain Intelligence Network, by **Crypto Relic**. Deterministic software detects and processes on-chain events; AI investigates selected, enriched events only (Engine 6 — never this one). Every finding must trace to tx hashes, block numbers, contract addresses, and timestamps.

Read these repo files before writing code:

- `README.md`
- `docs/BLUEPRINT.md` — §4 (Engine 2, including its stated limitations)
- `docs/BUILD_SPEC.md` — binding build rules for all agents
- `docs/architecture.md`
- `docs/database.md` and `migrations/001_init.sql`
- `docs/roadmap.md` — Phase 5 acceptance criteria (mempool parts)
- `packages/event_schemas/event.schema.json`, `packages/chain_config/chains.json`, `.env.example`
- `services/evm_listener/` — Engine 1's service. **Dependency:** this engine reuses Engine 1's npm-workspace packages (`@nexus/event-schemas`, `@nexus/shared-utils`) and its Postgres tables (`blocks`, `checkpoints`, `watchlists`). If Engine 1's PR has not merged yet, build against the interfaces named here and say so in your PR description — do not copy-paste forked versions of the shared packages.

**Stack:** TypeScript + viem · PostgreSQL 16 · Redis Streams · Docker Compose.

**Chains:** Ethereum (1) and Base (8453) live; Arbitrum/BSC config-only. Chain behavior must be config-driven from `packages/chain_config/chains.json`.

**Shared contracts you must honor:**

- Normalized events match `packages/event_schemas/event.schema.json` (`kind: "pending_tx"` for this engine).
- Redis Streams: you publish lifecycle events to `nexus:pending` and pending-tx normalized events to `nexus:events`. You consume nothing from Engine 1's stream — you read `blocks`/`checkpoints` tables to resolve inclusion.
- **Migration number assigned to this engine: `migrations/002_pending_transactions.sql`.** Never edit `001_init.sql`; never use another engine's number.

## Standing rails (non-negotiable)

- **$0 spend.** No paid services or subscriptions. Dev/test uses free public RPC endpoints or recorded fixtures only. Never commit a `.env` or a keyed endpoint URL.
- **No secrets in code.** Env vars only. Read-only monitoring: no signing, no transaction submission, no trading.
- **Deterministic only.** No LLM calls anywhere in this engine.
- **Brand:** user-facing strings say "Crypto Relic" / "NEXUS by Crypto Relic" only.
- **Pending is not confirmed.** This is the engine's core honesty rule (BLUEPRINT §4): a pending transaction is an early signal from one node's mempool, not a fact. Every output of this engine must carry its lifecycle status, and pending findings must never be worded as confirmed activity. Do not describe this feed as a complete global mempool view anywhere in code, docs, or messages.
- **Small reviewable PR.** Branch `devin/engine-2-mempool` off `main`. Do not edit `docs/BLUEPRINT.md` or `migrations/001_init.sql`. Do not merge your own PR. Report implemented vs planned honestly in the PR description, with test commands and output.
- **Definition of done (BUILD_SPEC):** code + tests pass; typed schemas; structured logging; bounded backoff; idempotent processing; no mock data in production paths; never replace a real subscription with polling — if a provider cannot do pending subscriptions, the engine disables that chain's mempool feed and says so (see `capability.ts` below).

## Engine goal

Observe transactions before inclusion on Ethereum and Base (where the provider supports it): subscribe to pending transaction hashes, fetch and decode each transaction (DEX swaps, liquidity adds/removes, contract deployments, large transfers, watched-contract interactions), estimate price impact where pool state is known, and track the full pending lifecycle — DETECTED → PENDING → INCLUDED / REPLACED / DROPPED → CONFIRMED / REORGED — persisting every transition as evidence.

## Exact deliverables

### `services/mempool_listener/` (new TypeScript package `@nexus/mempool-listener`, mirroring `services/evm_listener` layout)

- `package.json`, `tsconfig.json` — deps: `viem`, `pg`, `redis`, `@nexus/event-schemas`, `@nexus/shared-utils`; dev dep `vitest`; scripts `start`, `typecheck`, `test`.
- `src/config.ts` — chain config from `chains.json` + env (reuse the pattern from Engine 1's `config.ts`); tunables via env with defaults: `MEMPOOL_DROP_AFTER_BLOCKS=50`, `MEMPOOL_MAX_INFLIGHT=200`.
- `src/capability.ts` — per chain/provider, probe whether `eth_subscribe` `newPendingTransactions` actually works (subscribe once, await first notification or a short timeout). Result is logged and stored in `provider_health`. If unsupported: that chain's mempool feed is disabled with a clear log line — never silently substituted with polling.
- `src/subscription.ts` — pending-hash subscription with reconnect/backoff (reuse `@nexus/shared-utils` backoff); bounded-concurrency fetcher (`eth_getTransactionByHash`) with per-provider rate limiting.
- `src/signatures.ts` — method-signature table (selector → name + ABI fragment) covering at minimum: Uniswap V2 router `swapExactTokensForTokens`, `swapExactETHForTokens`, `addLiquidity`, `addLiquidityETH`, `removeLiquidity`, `removeLiquidityETH`; Uniswap V3 router `exactInputSingle`, `exactInput`, `mint`, `increaseLiquidity`, `decreaseLiquidity`; ERC-20 `transfer`/`approve`. Unknown selectors stay unknown — never guess a decode.
- `src/decoder.ts` — decode destination / calldata / value / method using the signature table; identify contract deployments (`to == null`); identify token + pair addresses where the calldata determines them; mark every decoded field that is an inference as an estimate.
- `src/lifecycle.ts` — the state machine, one row per pending tx:
  - `DETECTED` on first sight of the hash → `PENDING` once the full tx is fetched.
  - `INCLUDED` when the hash appears in a canonical block (checked against Engine 1's `blocks`/`transactions` tables as checkpoints advance).
  - `REPLACED` when a different hash with the same `(sender, nonce)` gets included first (record `replaced_by`).
  - `DROPPED` when neither the hash nor a replacement is included within `MEMPOOL_DROP_AFTER_BLOCKS` blocks.
  - `CONFIRMED` at the chain's confirmation depth; `REORGED` if its block is invalidated (log marked removed / block non-canonical).
  - Every transition is timestamped and persisted; transitions are idempotent (replaying the same block changes nothing).
- `src/watchlist.ts` — match pending txs against the `watchlists` table (wallets + contracts); matches are flagged on the lifecycle record and the emitted event.
- `src/publisher.ts` — lifecycle transitions to `nexus:pending`; decoded pending txs as `NexusNormalizedEvent` (`kind: "pending_tx"`, payload carrying `status`) to `nexus:events`.
- `src/main.ts` — per-chain isolated workers, structured logging, graceful shutdown.
- `migrations/002_pending_transactions.sql` — `pending_transactions` table: `(chain_id, hash)` PK, `sender`, `nonce`, `recipient`, `value`, `method`, `decoded JSONB`, `status`, `first_seen_at`, `first_seen_block`, `included_block`, `replaced_by`, `updated_at`; index on `(chain_id, sender, nonce)` and on `status`.
- `docker-compose.yml` — add a `mempool_listener` service.
- Replace `services/mempool_listener/README.md` stub with real docs, including an honest limitations section (single-node mempool view, private order flow invisible, provider differences).

### Tests (`services/mempool_listener/tests/`, vitest)

- `lifecycle.test.ts` — drives the full transition graph from fixtures: included, replaced (same sender+nonce, different hash), dropped (block window passes), reorged after inclusion.
- `decoder.test.ts` — recorded real calldata fixtures (a V2 swap, a V3 `exactInputSingle`, an `addLiquidity`, a deployment) decode to the expected method/tokens; an unknown selector decodes as unknown.
- `capability.test.ts` — a provider stub without pending-subscription support → feed disabled, explicit log, no polling fallback.
- `fixtures/` — recorded pending txs + block sequences, provenance labeled in `fixtures/README.md`.

## Acceptance checks (all must pass; paste output in the PR)

```bash
cd services/mempool_listener
npm install
npm run typecheck
npm test
```

Plus a fixture replay (script or test) whose output shows, for the recorded sequence: one tx going DETECTED → PENDING → INCLUDED → CONFIRMED, one REPLACED with `replaced_by` set, one DROPPED — and every emitted event carrying its `status`, with pending events never labeled confirmed.

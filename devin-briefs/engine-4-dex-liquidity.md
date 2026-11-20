# Devin Brief — Engine 4: DEX & Liquidity Intelligence

You are building **Engine 4 of NEXUS** in the GitHub repo **nftboy07/NEXUS** (branch off `main`). This brief is self-contained: everything you need is below or in the repo files it names.

## Project context (read first, in this order)

NEXUS — Autonomous Blockchain Intelligence Network, by **Crypto Relic**. Deterministic software detects and processes on-chain events; AI investigates selected, enriched events only (Engine 6 — never this one). Every finding must trace to tx hashes, block numbers, contract addresses, and timestamps.

Read these repo files before writing code:

- `README.md`
- `docs/BLUEPRINT.md` — §6 (Engine 4: pool/liquidity monitoring, removal alert contents, Liquidity Risk Radar)
- `docs/BUILD_SPEC.md` — binding build rules for all agents
- `docs/architecture.md`
- `docs/database.md` and `migrations/001_init.sql` — `pools` and `liquidity_events` tables already exist
- `docs/roadmap.md` — Phase 4 acceptance criteria
- `packages/event_schemas/event.schema.json`, `packages/chain_config/chains.json`, `packages/chain_config/log_filters.json` (created by Engine 1), `.env.example`
- `services/evm_listener/` — Engine 1's service. **Dependency:** you consume Engine 1's normalized log events from Redis stream `nexus:events` and reuse its workspace packages (`@nexus/event-schemas`, `@nexus/shared-utils`). Engine 1 subscribes to the log filters listed in `packages/chain_config/log_filters.json` — your first deliverable extends that file with the DEX event signatures below. If Engine 1's PR has not merged yet, build against the contracts named here with recorded fixtures and say so in your PR description.

**Stack:** TypeScript + viem (log decoding) · PostgreSQL 16 · Redis Streams.

**Chains:** Ethereum (1) and Base (8453) live; Arbitrum/BSC config-only. DEX/factory addresses are per-chain config, never hardcoded in logic.

**Shared contracts you must honor:**

- Input: `NexusNormalizedEvent` log events from `nexus:events` (consumer group; restarts resume without reprocessing).
- Alert output: rows in the `alerts` table **and** alert records on Redis stream `nexus:alerts` (source engine, kind, `chain_id`, facts, `dedup_key`) for Engine 7's dispatcher.
- **Migration number assigned to this engine: `migrations/004_pool_reserves.sql`.** Never edit `001_init.sql`; never use another engine's number.

## Standing rails (non-negotiable)

- **$0 spend.** No paid price feeds, APIs, or datasets. Where a metric would need an external price, either compute it in token units or return `null` with the missing source named — never invent a USD value.
- **No secrets in code.** Env vars only. Read-only: no signing, no transaction submission, no trading.
- **Deterministic only.** No LLM calls anywhere in this engine. The Risk Radar is transparent math: every metric ships with its inputs.
- **Brand:** user-facing strings say "Crypto Relic" / "NEXUS by Crypto Relic" only.
- **No single-metric verdicts.** The Liquidity Risk Radar (BLUEPRINT §6) is multi-metric and explanatory. Never emit a bare "safe" / "unsafe" / "rug" label for a pool — output the metrics and let the explanation string cite them.
- **Small reviewable PR.** Branch `devin/engine-4-dex-liquidity` off `main`. Do not edit `docs/BLUEPRINT.md` or `migrations/001_init.sql`. Do not merge your own PR. Report implemented vs planned honestly, with test commands and output.
- **Definition of done (BUILD_SPEC):** code + tests pass; typed schemas; structured logging; idempotent processing (replayed logs change nothing twice); no mock data in production paths.

## Engine goal

Decode DEX activity from the confirmed log stream into a live pool registry with reserve tracking: new pool detection, liquidity adds/removes, swap-driven reserve updates, price-impact estimation from reserves, liquidity-removal alerts with the exact contents BLUEPRINT §6 specifies, and a transparent multi-metric Liquidity Risk Radar (roadmap Phase 4 acceptance: *test cases correctly identify known pool/liquidity events*).

## Exact deliverables

### Config first

- Extend `packages/chain_config/log_filters.json` with the event signatures below (Uniswap V2/V3 factories + pairs/pools, Aerodrome factory on Base), and add `packages/chain_config/dexes.json`: per-chain DEX registry (name, factory address, router address, type `v2 | v3 | aerodrome`) for Ethereum + Base. Addresses must be the well-known mainnet/Base deployments; cite each address's source in a comment/README note — if you cannot verify an address from the repo or your own certain knowledge, leave that DEX out and say so in the PR rather than guessing an address.

### `services/dex_monitor/` (new TypeScript package `@nexus/dex-monitor`, mirroring `services/evm_listener` layout)

- `package.json`, `tsconfig.json` — deps: `viem`, `pg`, `redis`, `@nexus/event-schemas`, `@nexus/shared-utils`; dev dep `vitest`; scripts `start`, `typecheck`, `test`.
- `src/abis.ts` — minimal event ABI fragments: Uniswap V2 `PairCreated`, `Mint`, `Burn`, `Swap`, `Sync`; Uniswap V3 `PoolCreated`, `Mint`, `Burn`, `Swap`; Aerodrome `PoolCreated`, `Mint`, `Burn`, `Swap`, `Sync` (only the fragments you actually decode).
- `src/decoders.ts` — decode normalized logs into typed events: `PoolCreated`, `LiquidityAdded`, `LiquidityRemoved`, `Swap`, `ReserveUpdate`. Unknown contracts/signatures are ignored, never guessed.
- `src/pools.ts` — pool registry: upsert `pools` rows (id = chain + pair/pool contract address), token0/token1, DEX, fee tier (V3), creation block/tx.
- `src/liquidity.ts` — write `liquidity_events` rows for adds/removes with amounts, tx hash, block; maintain per-pool totals.
- `src/reserves.ts` — track reserves per pool from `Sync` (V2/Aerodrome) and `Swap`-derived balances (V3: track via liquidity + sqrtPriceX96 where decodable, else mark reserve source `partial`); write snapshot rows to `pool_reserves` (your migration) on change.
- `src/impact.ts` — constant-product price-impact estimation for representative trade sizes expressed as fractions of pool depth (0.1%, 1%, 5% of the input-side reserve): pure function of reserves, returns impact % per size with the reserves used. No external price data.
- `src/risk.ts` — Liquidity Risk Radar. Metrics (each returns value + inputs + data source, `null` when data is missing): depth (reserve size in token units), concentration (largest LP share where LP-token data exists), recent withdrawal % (removals / total liquidity over 24h), volume/liquidity ratio (from swaps), holder concentration (where available), pool age + activity level. Composite output = the metric set + a generated explanation string citing the values — never a single safe/unsafe verdict.
- `src/alerts.ts` — liquidity-removal alert when a single removal ≥ `LIQ_REMOVAL_ALERT_PCT` (env, default 20) of the pool's current liquidity. Alert facts exactly per BLUEPRINT §6: pool + DEX, initiating wallet, tx hash + block, assets + quantities removed, estimated value **with its valuation source stated** (or token units when no source), remaining liquidity after the removal, and the wallet's count of prior similar actions from stored history.
- `src/main.ts` — Redis consumer-group worker on `nexus:events`, structured logging, graceful shutdown.
- `migrations/004_pool_reserves.sql` — `pool_reserves` (`pool_id`, `chain_id`, `reserve0 NUMERIC`, `reserve1 NUMERIC`, `source TEXT`, `block_number`, `ts`; PK `(pool_id, block_number)`) and `ALTER TABLE pools ADD COLUMN IF NOT EXISTS fee_tier INTEGER, ADD COLUMN IF NOT EXISTS created_block BIGINT, ADD COLUMN IF NOT EXISTS created_tx TEXT`.
- Replace `services/dex_monitor/README.md` stub with real setup/run docs + the Risk Radar metric definitions.

### Tests (`services/dex_monitor/tests/`, vitest)

- `decoders.test.ts` — recorded real mainnet/Base log fixtures decode to the expected typed events: one V2 `PairCreated`, one V3 `PoolCreated`, one `Mint`, one `Burn` (removal), one `Swap` + `Sync`. Fixture provenance (chain, tx hash, block) documented in `fixtures/README.md` — these must be real recorded logs, not invented ones.
- `impact.test.ts` — hand-computed constant-product cases match the implementation.
- `risk.test.ts` — fixture pool history → expected metric values; a pool with a 60% single removal shows withdrawal % ≈ 60 and an explanation citing it, with no safe/unsafe label anywhere in the output.
- `alerts.test.ts` — removal at exactly the threshold alerts with all BLUEPRINT §6 fields present; just below does not; replaying the same log produces exactly one alert.
- End-to-end replay: fixture log sequence → expected `pools`, `liquidity_events`, `pool_reserves` rows.

## Acceptance checks (all must pass; paste output in the PR)

```bash
cd services/dex_monitor
npm install
npm run typecheck
npm test
```

Plus the end-to-end replay run against local Postgres + Redis from `docker-compose.yml`, with one sample liquidity-removal alert record printed in the PR description showing every required field and its valuation source (or token-units statement).

# Devin Brief — Engine 5: MEV & Transaction Intelligence

You are building **Engine 5 of NEXUS** in the GitHub repo **nftboy07/NEXUS** (branch off `main`). This brief is self-contained: everything you need is below or in the repo files it names.

## Project context (read first, in this order)

NEXUS — Autonomous Blockchain Intelligence Network, by **Crypto Relic**. Deterministic software detects and processes on-chain events; AI investigates selected, enriched events only (Engine 6 — never this one). Every finding must trace to tx hashes, block numbers, contract addresses, and timestamps.

Read these repo files before writing code:

- `README.md`
- `docs/BLUEPRINT.md` — §7 (Engine 5: patterns, analysis inputs, pre-trade protection, visibility limits)
- `docs/BUILD_SPEC.md` — binding build rules for all agents
- `docs/architecture.md`
- `docs/database.md` and `migrations/001_init.sql`
- `docs/roadmap.md` — Phase 5 acceptance criteria (MEV parts)
- `packages/event_schemas/event.schema.json`, `packages/chain_config/chains.json`, `.env.example`
- **Dependencies (read their service dirs):** Engine 1 (`services/evm_listener/` — `blocks`, `transactions`, `logs` tables), Engine 2 (`services/mempool_listener/` — `pending_transactions` lifecycle table), Engine 4 (`services/dex_monitor/` — `pools`, `pool_reserves`, `liquidity_events`). This engine is an offline/near-line analyzer over their stored data; it subscribes to nothing itself. If a dependency PR has not merged yet, build against the table contracts named here with fixtures and say so in your PR description.

**Stack:** Python 3.12 · PostgreSQL 16. (Redis only if you emit alerts — see below.)

**Chains:** Ethereum (1) and Base (8453) live; Arbitrum/BSC config-only.

**Shared contracts you must honor:**

- Findings are rows in your new `mev_findings` table; every finding carries an `evidence` list of tx hashes + block numbers and a `confidence` with the reason.
- Alert output (for high-confidence findings only): rows in the `alerts` table **and** records on Redis stream `nexus:alerts` (source engine, kind, `chain_id`, facts, `dedup_key`) for Engine 7's dispatcher.
- **Migration number assigned to this engine: `migrations/005_mev_findings.sql`.** Never edit `001_init.sql`; never use another engine's number.

## Standing rails (non-negotiable)

- **$0 spend.** No paid data or APIs; analysis runs only over data already stored by Engines 1/2/4.
- **No secrets in code.** Env vars only. Read-only: no signing, no transaction submission, no trading, no bundle submission — this engine *observes and reports*, it never participates in MEV.
- **Deterministic only.** No LLM calls anywhere in this engine. Pattern detection is explicit rules + math.
- **Brand:** user-facing strings say "Crypto Relic" / "NEXUS by Crypto Relic" only.
- **Evidence sufficiency is a hard gate.** Private order flow and incomplete mempool visibility mean detection is never exhaustive (BLUEPRINT §7). A pattern that *resembles* a sandwich is labeled a resemblance with its evidence — never asserted as proven intent. If the data needed to confirm a pattern (e.g. pool reserves at that block) is missing, the finding is **not emitted**; it is counted in a run-stats log as "insufficient evidence". False positives are worse than misses.
- **Small reviewable PR.** Branch `devin/engine-5-mev` off `main`. Do not edit `docs/BLUEPRINT.md` or `migrations/001_init.sql`. Do not merge your own PR. Report implemented vs planned honestly, with test commands and output.
- **Definition of done (BUILD_SPEC):** code + tests pass; typed schemas (pydantic); structured logging; idempotent analysis (re-analyzing a block yields the same findings, never duplicates); no mock data in production paths.

## Engine goal

Analyze confirmed blocks (enriched with Engine 2's pending data and Engine 4's pool/reserve state) for MEV and transaction patterns — potential sandwiches, arbitrage, liquidations, unusual gas bidding — with reserve-based impact estimation and strict evidence sufficiency, plus a deterministic pre-trade protection check (expected impact/slippage vs pool depth) that other components can call.

## Exact deliverables

### `services/mev_analyzer/` (new Python package)

- `requirements.txt` — `psycopg[binary]`, `pydantic`, `redis` (alerts only), `pytest`.
- `src/models.py` — pydantic models: `BlockTxSequence`, `Finding` (kind, chain, block, initiator, victim | None, pool_id, evidence[], estimated_impact{}, confidence{level, rationale}), `ProtectionReport`.
- `src/blocks.py` — assemble per-block ordered tx sequences for a block range from `transactions` + decoded DEX activity (join Engine 4's `liquidity_events` / swap decoding where available; fall back to raw `logs` for known DEX topics). Track a `mev_analyzer_cursor` (own small table or reuse a state row — if you need a table, include it in migration 005) so runs are incremental and idempotent per block.
- `src/sandwich.py` — candidate pattern, all conditions required: same pool; within one block, tx A1 (initiator X swaps token→token), victim tx V (different sender, same direction, between A1 and A2 in block order), tx A2 (initiator X swaps back); victim's executed price is worse than the price implied by reserves before A1 by more than a configurable threshold (`MEV_MIN_VICTIM_IMPACT_PCT`, env, default 0.5). Impact is estimated from Engine 4's `pool_reserves` at that block; **if reserves at that block are unavailable, emit nothing** (count as insufficient evidence). Output labels the pattern "potential sandwich" with the full tx evidence.
- `src/arbitrage.py` — same-block, same-sender cyclic trades across ≥2 pools in our registry whose net token deltas are positive in the start token (fees ignored → label the profit figure an estimate and say fees are excluded).
- `src/liquidations.py` — decode liquidation events from the `logs` table for Aave V2/V3 (`LiquidationCall`) and Compound (`LiquidateBorrow`) on Ethereum + Base: protocol contract addresses go in a per-chain config file `src/protocols.json` with sources cited — if you cannot verify an address, leave that protocol out and say so in the PR rather than guessing. Findings carry borrower, liquidator, collateral/debt assets + amounts, tx + block.
- `src/gas.py` — per-block priority-fee statistics; flag txs whose priority fee exceeds the block's 95th percentile by a configurable multiple — output labeled a statistical observation, not an MEV claim.
- `src/protection.py` — pre-trade protection check, a pure function + importable module: input `(chain_id, pool_id, token_in, amount_in)` → expected price impact % and slippage warning derived from `pool_reserves` (constant-product math consistent with Engine 4's `impact.ts` — same formulas, cite them), plus the reserve snapshot's block number and age. Stale reserves (> `PROTECTION_MAX_RESERVE_AGE_BLOCKS`, env, default 100) → report says so and impact is `null`, never guessed.
- `src/findings.py` — persist findings idempotently (unique on kind + block + primary tx hash), write run stats (blocks analyzed, candidates rejected for insufficient evidence, per kind), emit alerts for high-confidence findings only.
- `src/main.py` — batch analyzer entrypoint: process from cursor to latest checkpoint per chain; structured logging; safe to run repeatedly (cron-friendly).
- `migrations/005_mev_findings.sql` — `mev_findings` (`id` PK, `chain_id`, `block_number`, `kind`, `initiator`, `victim`, `pool_id`, `evidence JSONB`, `estimated_impact JSONB`, `confidence JSONB`, `created_at`; unique `(kind, chain_id, block_number, initiator, pool_id)`) + `mev_analyzer_cursor` (`chain_id` PK, `last_block`).
- Replace `services/mev_analyzer/README.md` stub with real docs: pattern definitions, thresholds, and the visibility limitations.

### Tests (`services/mev_analyzer/tests/`, pytest) — negative cases are mandatory

- `test_sandwich.py` — synthetic block fixture with a planted A1→V→A2 sequence + reserves → exactly one finding with the three tx hashes as evidence and a computed victim impact. **Negative:** two independent same-pool swaps in one block (no closing A2) → no finding. **Negative:** planted sequence but reserves missing → no finding, insufficient-evidence counter increments.
- `test_arbitrage.py` — planted profitable cycle → finding with estimate labeled fee-excluded; a losing cycle → no finding.
- `test_liquidations.py` — recorded liquidation log fixture decodes to the expected fields.
- `test_protection.py` — impact math matches hand-computed constant-product values; stale reserves → `null` impact with the staleness stated.
- `test_idempotency.py` — analyzing the same block range twice yields identical finding counts.
- `fixtures/` — synthetic block sequences (clearly labeled synthetic in `fixtures/README.md`) + any recorded real logs with provenance.

## Acceptance checks (all must pass; paste output in the PR)

```bash
cd services/mev_analyzer
pip install -r requirements.txt
pytest
```

Plus one analyzer run over the fixture dataset against local Postgres from `docker-compose.yml`, printing: blocks analyzed, findings per kind, and the insufficient-evidence rejection count — all three numbers must appear in the PR description.

# mev_analyzer — Engine 5 (MEV & Transaction Intelligence)

Python 3.12 batch analyzer over data already stored by Engines 1/2/4 —
transactions, pending lifecycle, pools/reserves/liquidity events, logs.
Subscribes to nothing; safe to run repeatedly (incremental via
`mev_analyzer_cursor`, idempotent via a unique key per finding).

**It observes and reports — never participates.** No signing, no
submission, no bundle building, no trading.

## Patterns (explicit rules + math; deterministic only)

| kind | rule | threshold |
|---|---|---|
| `potential_sandwich` | same pool: initiator swap → victim swap same direction → initiator swap back, all in one block; front-leg price move ≥ `MEV_MIN_VICTIM_IMPACT_PCT` (default 0.5) vs pre-trade reserves | labeled a *resemblance*, never proven intent; missing reserves → not emitted, counted insufficient |
| `cyclic_arbitrage` | same sender, ≥2 known pools, one block, positive net token delta | fees excluded — profit figure is an estimate |
| `liquidation` | `LiquidationCall` logs from configured Aave V2/V3 pools (`src/protocols.json`, sources cited). Compound `LiquidateBorrow` emits from per-market cTokens — not configured, so not covered | observed events → high confidence |
| `gas_outlier` | priority fee > block p95 × 3 | statistical observation only; requires a `priority_fee` field that `transactions` does not yet store — produces nothing until Engine 1 stores it |
| `protection.check_trade` | constant-product impact (same formula as `dex_monitor/src/impact.ts`: `out = dx·997·rOut / (rIn·10000 + dx·997)`, `impact = 1 − effectivePrice/spotPrice`) | reserves older than `PROTECTION_MAX_RESERVE_AGE_BLOCKS` (default 100) → `impact_pct = null`, staleness stated |

## Visibility limitations

Findings derive only from stored data: private order flow and Engine 2's
single-provider mempool view mean detection is never exhaustive — misses
are expected; findings are labeled with evidence and confidence, and
anything short on evidence is rejected, not guessed.

## Run

```bash
pip install -r requirements.txt
export DATABASE_URL=postgresql://nexus:nexus@localhost:5432/nexus
export REDIS_URL=redis://localhost:6379   # optional, for nexus:alerts
python src/main.py                        # prints run stats
```

Env: `MEV_CHAIN_IDS` (`1,8453`), `MEV_MIN_VICTIM_IMPACT_PCT` (`0.5`),
`MEV_BATCH_BLOCKS` (500 — first-run lookback when no cursor),
`PROTECTION_MAX_RESERVE_AGE_BLOCKS` (100). High-confidence findings write
an `alerts` row + `nexus:alerts` record (dedup_key'd).

## Tests

`pytest` — sandwich positive/negative/insufficient-evidence, arbitrage,
recorded Aave V3 liquidation decode (fixture provenance in
`tests/fixtures/README.md`), protection math + staleness, idempotency.
Live Postgres/Redis run was not performed (Docker unavailable); the store
is interface-faked.

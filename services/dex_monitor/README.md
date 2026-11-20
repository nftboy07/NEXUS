# @nexus/dex-monitor

Engine 4 of **NEXUS by Crypto Relic** — DEX & Liquidity Intelligence.
Consumes Engine 1's normalized log events from the Redis stream
`nexus:events` (consumer group `dex_monitor`, so restarts resume without
reprocessing), decodes DEX activity into a live pool registry with reserve
tracking, and emits liquidity-removal alerts to the `alerts` table **and**
the `nexus:alerts` stream for Engine 7.

## What it does

- **New pool detection** — `PairCreated` (Uniswap V2, SushiSwap),
  `PoolCreated` (Uniswap V3, Aerodrome) from the factories in
  `packages/chain_config/dexes.json` → `pools` rows (id `chain_id:address`,
  fee tier for V3, creation block/tx).
- **Liquidity add/remove** — V2 + V3 `Mint`/`Burn` on registered pools →
  `liquidity_events` (`add`/`remove`, token amounts, tx hash, block).
- **Swaps** — recorded as `liquidity_events` type `swap` for volume metrics.
- **Reserves** — V2/Aerodrome `Sync` → `pool_reserves` snapshots
  (`source='sync'`). V3 swaps record `source='partial'` markers — full V3
  reserves are not derivable from the swap log alone.
- **Removal alerts** — a single removal ≥ `LIQ_REMOVAL_ALERT_PCT` (default
  20) of the pool's net liquidity emits one alert per `dedup_key` with the
  BLUEPRINT §6 fields (pool+DEX, wallet + its source, tx+block, amounts,
  removal %, valuation with source stated — token units only, no price feed
  on a $0 budget — remaining liquidity, prior similar actions via the
  `transactions` table).
- **Price impact** — `src/impact.ts`: constant-product impact for trades of
  0.1%/1%/5% of the input reserve, pure function of stored reserves.

## Config

- `packages/chain_config/log_filters.json` — DEX event signatures subscribed
  by Engine 1 (factory events are address-scoped; pair events are unscoped
  and filtered to registered pools at decode time).
- `packages/chain_config/dexes.json` — per-chain DEX registry (name,
  factory, router, type, `address_source` citation for each address).
- `migrations/004_pool_reserves.sql` — `pool_reserves` + `pools` columns;
  auto-applied via the postgres `/docker-entrypoint-initdb.d` mount.

## Run

```bash
cp ../../.env.example ../../.env   # DATABASE_URL, REDIS_URL
docker compose up -d postgres redis
npm install                        # from repo root
cd services/dex_monitor && npm start
```

## Liquidity Risk Radar (`src/risk.ts`)

Transparent multi-metric report — every metric returns `{value, inputs,
source}` and is `null` with the missing source named when data is absent.
No safe/unsafe verdicts, ever.

| Metric | Definition | Source |
|---|---|---|
| `depth` | latest reserve0/reserve1 in raw token units | `pool_reserves` (Sync) |
| `lp_concentration` | largest LP share | `null` — LP holder data not collected |
| `withdrawal_24h_pct` | removals last 24h / net liquidity | `liquidity_events` |
| `volume_liquidity_ratio` | 24h swap token0 amount / reserve0 | `liquidity_events` + `pool_reserves` |
| `holder_concentration` | token holder concentration | `null` — not collected |
| `age_and_activity` | blocks since `created_block`, event count | `pools` + `liquidity_events` |
| `price_impact` | impact % for 0.1/1/5%-of-depth trades | constant-product math |

`explanation` is a generated string citing the values above — not a verdict.

## Tests

```bash
npm run typecheck
npm test
```

vitest suite: real recorded mainnet/Base log fixtures decode correctly
(`tests/fixtures/README.md` — chain, tx, block provenance), hand-computed
impact math, risk metrics on seeded history, alert threshold/dedup, and an
end-to-end replay test.

# @nexus/evm-listener

Engine 1 of **NEXUS by Crypto Relic** — the multi-chain RPC listener network.
Per-chain WebSocket subscriptions (new heads + configured logs) with durable
Postgres storage, per-chain checkpoints, HTTP backfill after any gap,
primary→secondary failover, reorg handling, provider health metrics, and
normalized events published to the Redis stream `nexus:events`.

## Design

| Piece | File | Notes |
|---|---|---|
| Chain config | `src/config.ts` | Reads `packages/chain_config/chains.json`; `planned` chains skipped; per-chain `wss_env`/`http_env`; `<ENV>_SECONDARY` failover vars; fails loudly on missing primary env. |
| RPC clients | `src/rpc.ts` | viem WS + HTTP public clients, primary and secondary. `ChainSource` is the injectable boundary used by tests. |
| Subscriptions | `src/subscriptions.ts` | `watchBlocks` + `watchEvent` from `packages/chain_config/log_filters.json` (never hardcoded). Heartbeat timestamps per subscription. |
| Storage | `src/store.ts` | `blocks`, `logs`, `transactions` — `ON CONFLICT DO NOTHING` on the `001_init.sql` PKs. `markLogsRemoved(chainId, blockHash)` for reorgs. `EventStore` interface → `PgStore` in prod, fake in tests. |
| Checkpoints | `src/checkpoint.ts` | `checkpoints` table per chain; advances only after a block's events are stored AND published; `rewindCheckpoint` for reorgs. |
| Backfill | `src/backfill.ts` | `eth_getLogs` + block fetches for `(checkpoint, head]` in bounded chunks (`BACKFILL_CHUNK_SIZE`, default 2000); dedup via store upserts. Runs at startup and after every reconnect. Provider range/result-limit errors halve the window recursively to 1 block; other transient RPC errors use bounded retry. One request per filter with its own address+topics. Cold start seeds the checkpoint at `head - START_BACKFILL_BLOCKS` (default 50) or the chain's `start_block` in `chains.json`. |
| Failover | `src/failover.ts` | Bounded backoff reconnect → secondary provider → backfill → resubscribe; outages recorded in `provider_health`. |
| Reorgs | `src/reorg.ts` | Parent-hash verification per new head within the chain's `confirmations` depth; walks back to the common ancestor, marks orphaned logs `removed = TRUE`, rewinds the checkpoint, backfill reprocesses the canonical range. |
| Publisher | `src/publisher.ts` | `XADD` each `NexusNormalizedEvent` to `nexus:events`. |
| Health | `src/health.ts` | Periodic `provider_health` rows (provider, chain, latency ms, errors) + reconnect counters. |
| Orchestrator | `src/listener.ts` + `src/runner.ts` | One isolated `ChainRunner` per enabled chain — one chain failing never stops the others. Graceful shutdown on SIGTERM/SIGINT. |

New-head flow: live log subscription ingests immediately; each new head then
reconciles that block's logs over HTTP (dedup makes it a no-op when the
subscription already delivered) and only then advances the checkpoint — so a
restart never silently skips events.

## Setup

```bash
cp ../../.env.example ../../.env   # set WSS_RPC_URL / HTTP_RPC_URL (+ _BASE for Base)
docker compose up -d postgres redis
npm install                        # from repo root (npm workspaces)
```

`docker-compose.yml` mounts `./migrations` into the postgres container at
`/docker-entrypoint-initdb.d` (read-only), so `001_init.sql` runs
automatically on first init of a fresh `nexus_pg` volume. If the volume
already exists, apply it once manually:
`psql "$DATABASE_URL" -f migrations/001_init.sql`.

## Run

```bash
cd services/evm_listener
npm start          # tsx src/listener.ts
```

## Recovery behavior

- **Restart:** startup backfill fills `(checkpoint, head]`; store upserts
  dedup redelivered logs — zero duplicate
  `(chain_id, block_hash, transaction_hash, log_index)` rows.
- **WS drop / heartbeat timeout:** backoff reconnect → secondary → backfill
  from checkpoint → resubscribe. Reconnecting is never assumed to recover
  missed events.
- **Reorg:** orphaned-block logs are flagged `removed = TRUE`, the checkpoint
  rewinds to the common ancestor, and the canonical range is reprocessed.
- **Chain isolation:** chains run in independent runners; one failing chain
  logs an error and the others keep ingesting.

## Tests

```bash
npm run typecheck
npm test
```

Fixture-backed vitest suite under `tests/` covers dedup, normalization,
backfill gaps, reorg rewind, and per-chain isolation. Fixture provenance:
`tests/fixtures/README.md` (synthetic — not real on-chain data).

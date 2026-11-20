# NEXUS Operations

## Restarts

All daemons are `restart: unless-stopped` in docker-compose. State that
must survive restarts lives in Postgres (checkpoints, dedup keys, alert
delivery state) — restarting a service resumes from its checkpoint, and
all sinks are idempotent (ON CONFLICT DO NOTHING / unique dedup keys /
consumer-group acks), so replayed events never duplicate rows or alerts.

## Re-applying migrations on an existing volume

`/docker-entrypoint-initdb.d` runs **only on a fresh volume**. For an
existing database apply new migrations manually:

```bash
psql $DATABASE_URL -f migrations/010_alert_identity.sql
```

Migrations are written idempotent (`IF NOT EXISTS`, `ADD COLUMN IF NOT
EXISTS`) — re-running a migration is safe. Never edit
`migrations/001_init.sql` after the volume exists; add a new numbered
file instead.

## Backfill / gap recovery

- Engine 1 backfills `(checkpoint, head]` on startup and whenever a
  head skips blocks (`block.number > checkpoint + 1`), in bounded chunks
  with adaptive range shrinking on provider result-limit errors.
- Cold start: no checkpoint → seed at `head - START_BACKFILL_BLOCKS`
  (default 50) or the chain's `start_block` in chains.json.
- To force a re-backfill, delete the checkpoint row for that chain —
  rows are deduped on insert, so reprocessing is safe:
  `DELETE FROM checkpoints WHERE chain_id = 1;`

## Reorgs

Engine 1 detects parent-hash mismatches within `confirmations`, marks
orphaned logs `removed=TRUE`, rewinds the checkpoint, and emits one
`block_removed` event per orphaned block (deduped via `removed_blocks`).
Engines 3/4 delete derived rows for the orphaned `block_hash`; already
sent alerts are kept and followed by a `reorg_invalidation` alert.
Recovery is automatic — no operator action needed.

## Provider failover

When the WebSocket fails, Engine 1 backs off, switches to the secondary
endpoint (`*_SECONDARY` env vars), backfills the gap, resubscribes, and
writes a `provider_health` row. Engine 2 disables its pending feed when
the provider lacks pending-subscription support (recorded in
`provider_health`) — confirmed-ingestion is unaffected.

## Alert delivery failures

The dispatcher retries each channel up to 3 times and records per-channel
state in `alert_deliveries`. A `failed` channel never blocks others and
is retried on the next replay of that alert; a `sent` channel is never
re-sent. Unconfigured channels are `skipped_no_config` — delivery
continues for the rest.

## Investigations

`POST /investigations` (or the Engine 6 CLI) creates a row; without
`LLM_API_KEY`/`LLM_MODEL` it stays `awaiting_model` — run the CLI once
credentials are configured. `validation_failed` reports are retained for
audit, flagged unverified, never presented as verified.

## Scoped log filters

`LOG_FILTER_MODE=scoped` (default) subscribes to: allowlisted token
Transfers (`packages/chain_config/tokens.json`, addresses verified
on-chain via `symbol()`/`decimals()`), Transfers where topic1/topic2 is a
watchlist wallet, and DEX events on factories + pinned pools
(`dexes.json`) + every pool row. `LOG_FILTER_MODE=full` restores the
previous unscoped subscriptions.

Filters rebuild every `FILTER_REFRESH_SECONDS` (default 60). When a new
watchlist wallet or pool appears, the listener resubscribes and
backfills **from the checkpoint forward** — activity before the address
was added is intentionally NOT backfilled. Address arrays chunk at
`MAX_FILTER_ADDRESSES` (default 100) per filter.

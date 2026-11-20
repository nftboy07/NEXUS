# mempool_listener — Engine 2 (Mempool Intelligence)

Observes transactions **before inclusion** on Ethereum (1) and Base (8453)
where the provider supports `eth_subscribe newPendingTransactions`, decodes
them (DEX swaps, liquidity ops, deployments, large transfers,
watched-contract interactions), and tracks the full lifecycle
`DETECTED → PENDING → INCLUDED / REPLACED / DROPPED → CONFIRMED / REORGED`,
persisting every transition in `pending_transactions` (migration 002).

## Honest limitations (BLUEPRINT §4)

- **This is a single-node mempool view, not a complete global mempool feed.**
  Each provider sees a subset of pending transactions; txs a node never
  gossips are invisible here.
- **Private order flow is invisible.** Transactions sent through private
  relays (Flashbots Protect etc.) never reach a public mempool.
- **Pending is not confirmed.** Every emitted event carries its lifecycle
  `status`; a `pending_tx` event is an early signal, never confirmed
  activity. Nothing in this service substitutes polling for real pending
  subscriptions — a provider without support disables that chain's feed.

## Setup

```bash
npm install
npm run typecheck
npm test
```

## Run

```bash
export WSS_RPC_URL=...        # ethereum ws
export HTTP_RPC_URL=...
export WSS_RPC_URL_BASE=...   # base ws
export HTTP_RPC_URL_BASE=...
export REDIS_URL=redis://localhost:6379
export DATABASE_URL=postgresql://nexus:nexus@localhost:5432/nexus
npm start                     # or: docker compose up mempool_listener
```

Env: `MEMPOOL_DROP_AFTER_BLOCKS` (default 50), `MEMPOOL_MAX_INFLIGHT`
(default 200). Requires migrations `001_init.sql` +
`002_pending_transactions.sql` (the second also adds `nonce`/`block_hash`
columns to `transactions` for replacement/reorg resolution).

## How it works

- `capability.ts` probes each chain once at startup; unsupported providers
  log "mempool feed disabled" + record `provider_health`, no fallback.
- `subscription.ts` bounds in-flight `eth_getTransactionByHash` calls
  (`MEMPOOL_MAX_INFLIGHT`) with a per-provider rate limit and shared retry.
- `lifecycle.ts` resolves inclusion/replacement/drop/confirm/reorg strictly
  from Engine 1's canonical tables (`transactions`, `checkpoints`,
  `blocks`) — never from mempool guesses. Transitions are idempotent.
- `publisher.ts` writes lifecycle transitions to `nexus:pending` and
  `kind:"pending_tx"` normalized events (payload carries `status`) to
  `nexus:events`.
- `watchlist.ts` flags sender/recipient/contract/token matches from the
  `watchlists` table.

## Tests

`vitest run` — decoder coverage on real recorded calldata (V2 swap, V3
exactInputSingle, addLiquidity, deployment, unknown selector; provenance in
`tests/fixtures/README.md`), full lifecycle transitions incl. the
DETECTED→PENDING→INCLUDED→CONFIRMED replay, replaced/dropped/reorged, and
capability-disabled behavior. Live Postgres/Redis smoke was not run (Docker
unavailable); stores are interface-faked.

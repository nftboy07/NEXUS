# NEXUS Dashboard (apps/dashboard)

Next.js 14 App Router dashboard for NEXUS by Crypto Relic. Pages:
Overview, Live Feed (10s auto-refresh), Mempool (PENDING states always
labeled UNCONFIRMED), Wallet Intelligence (lookup by address), Whale
Radar, DEX Radar, MEV Monitor, AI Investigations (citations link to
explorer evidence), Watchlists (CRUD), Alerts (+ per-alert detail with
facts/assessment/deliveries), System Health.

All tx hashes, addresses, and block numbers link to the chain's
explorer (`explorer_url` in `packages/chain_config/chains.json`,
mirrored in `lib/explorers.ts`).

## API key stays server-side

`NEXUS_API_URL` + `NEXUS_API_KEY` are read only in server code
(`lib/api.ts` and the `app/api/nexus/[...path]` proxy route). Browser
components call `/api/nexus/*`; the key is never shipped to the bundle.

## Run

```bash
npm install
NEXUS_API_URL=http://localhost:8000 NEXUS_API_KEY=... npm run dev
npm run build && npm run lint && npm run typecheck && npm test
```

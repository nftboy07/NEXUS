# NEXUS Roadmap

## Phase 1 — Foundation: one reliable EVM listener
Configure one chain; WebSocket RPC; subscribe to new blocks + selected logs; store block/event records; checkpointing; reconnection + backfill; test duplicates + simulated outages.
**Acceptance:** Restarting does not silently skip events; repeated delivery creates no duplicates.

## Phase 2 — Multi-chain ingestion
Add Base, Arbitrum, BSC as separate configs; independent providers; normalized events; per-chain checkpoints; health metrics + failover; test finality/reorg behavior.
**Acceptance:** One network can fail without stopping the others.

## Phase 3 — Wallet & whale intelligence
Watchlists; transfers + selected contract interactions; wallet profiles; configurable thresholds; transparent wallet metrics; evidence links in alerts.
**Acceptance:** Every alert traces to stored on-chain evidence.

## Phase 4 — DEX & liquidity intelligence
Decode supported DEX events; track pools/reserves; detect pool creation + liquidity changes; liquidity + price-impact indicators; risk explanations.
**Acceptance:** Test cases correctly identify known pool/liquidity events.

## Phase 5 — Mempool & MEV
Pending subscriptions where supported; decode selected tx types; pending→included lifecycle; observable ordering patterns; measure provider visibility/latency.
**Acceptance:** Pending alerts clearly distinguished from confirmed; dropped/replaced/reorged handled.

## Phase 6 — AI investigation
Structured investigation packages; LLM provider; restricted tools + output schemas; validate cited tx hashes against retrieved data; confidence + alternatives; measure cost per investigation.
**Acceptance:** AI reports never present unsupported claims as verified facts.

## Phase 7 — Dashboard & release
Live dashboard; watchlists; alert history; investigation pages; Telegram; auth + API keys; monitoring, backups, ops docs.
**Acceptance:** A user can configure a watchlist, receive an alert, open the evidence, and inspect the investigation.

## Dashboard pages
Overview · Live Feed · Mempool · Wallet Intelligence · Whale Radar · DEX Radar · MEV Monitor · AI Investigations · Watchlists · Alerts · System Health · Settings

## KPIs
Event ingestion lag · processing lag · queue depth · RPC uptime · reconnect count · backfill duration · duplicate rate · reorg recovery time · alert delivery latency · AI cost per investigation · evidence validation rate. Set SLOs only after measuring.

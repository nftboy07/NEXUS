# NEXUS — Complete Project Blueprint and Implementation Plan

*Owner's original idea document — Crypto Relic. This file is the canonical blueprint; see architecture.md, roadmap.md, database.md, BUDGET.md and BUILD_SPEC.md for the extracted working docs.*

**Purpose:** Build a continuously running, multi-chain blockchain intelligence platform that listens to on-chain activity, monitors visible pending transactions, analyzes wallets and liquidity, detects suspicious patterns, and produces evidence-backed alerts.

**Budget target:** $200 in cloud/API credits — a constrained prototype budget, not a promise that a fully production-scale multi-chain system can run indefinitely for $200.

## 1. Executive summary
Do not build another basic whale tracker, Telegram bot, mempool monitor, or token scanner. Build one platform combining those capabilities. Seven subsystems: (1) Multi-chain RPC listener network, (2) Mempool intelligence engine, (3) Smart Money and Whale Intelligence, (4) DEX and Liquidity Intelligence, (5) MEV and Transaction Intelligence, (6) AI Investigation Agent, (7) Alerting and optional transaction execution.

Core principle: **Deterministic software detects and processes blockchain events. AI investigates selected, enriched events. AI must not sit in the critical path of event ingestion.** The listener continues if AI is unavailable. Every material finding traces to tx hashes, block numbers, contract addresses, timestamps.

Delivers: live block/contract-event monitoring; wallet/token watchlists; pending tx visibility where supported; whale transfer/accumulation alerts; new pool + liquidity-change detection; wallet relationship investigations; suspicious activity + risk indicators; AI investigation reports with evidence; Telegram/Discord/dashboard/API delivery; optional execution only after simulation, limits, human approval.

## 2. High-level architecture
See architecture.md for the full diagram and 10-step data flow (stream → validate → normalize → dedup → durable queue → decode/enrich → rules/scoring → AI investigation → store/deliver → checkpoint recovery).

## 3. Engine 1 — Multi-chain RPC listener network
Foundation. EVM methods: eth_subscribe newHeads / logs / newPendingTransactions (where supported), eth_getTransactionByHash, eth_getLogs, eth_getBlockByNumber, eth_blockNumber. Not every provider supports every subscription — confirm capabilities, rate limits, archive access, chain coverage before selecting.
Providers to evaluate: Alchemy, QuickNode, Tenderly, Blocknative (verify current plans/pricing/features on chosen tier).
Listener maintains: connection health/heartbeat, last observed block, last processed block, last log position, provider latency/error rate, reconnection/resubscription state, duplicate detection, reorg recovery, backfill progress, per-network rate limits.
Failover: detect WS break → exponential backoff reconnect → switch secondary → read durable checkpoint → HTTP backfill missing range → dedup → resume subscriptions → record outage in health metrics. Never assume reconnecting recovers missed events.
Reorgs: store block + parent hashes, track confirmation depth per chain, reverse/invalidate derived state for removed logs / non-canonical blocks.

## 4. Engine 2 — Mempool intelligence
Observes txs before inclusion — early signal, not a complete view. Monitors pending swaps, large txs, liquidity adds/removes, deployments, DEX txs, gas/priority-fee changes, watched-contract interactions, replacements/drops where observable.
Workflow: pending hash → fetch tx → decode destination/calldata/value/method → identify DEX/tokens/pair → estimate price impact from pool state → compare watchlists → alert marked PENDING → track included/replaced/dropped/reorged.
Lifecycle: DETECTED → PENDING → (REPLACED | DROPPED) | INCLUDED → CONFIRMATION TRACKING → (REORGED) | CONFIRMED.
Limitations: a node sees only its own mempool; nodes differ; private relays/order flow invisible; pending txs can be replaced, dropped, reverted, never included; provider-specific limits. Do not advertise as a complete global mempool feed.

## 5. Engine 3 — Smart Money & Whale Intelligence
Behavioral wallet profiles, not balance lists. Tracks large transfers, accumulation/distribution, exchange deposits/withdrawals (reliable labels only), newly funded wallets, wallet relationships, repeated patterns, realized performance, discovery/entry timing, failed txs/fees/losses.
Cluster investigation: same funding source? known exchange/service? same token purchases? similar time window? prior interaction? similar past behavior? alternative explanations (exchange batching, common infrastructure)? A shared funding source is a clue, not proof of common ownership.
Smart Money Score (starting weights, unvalidated — test historically, avoid survivorship bias, include fees/failed/unrealized): realized performance 30%, risk-adjusted 20%, early discovery 20%, consistency 15%, behavioral reliability 15%.
Wallet profile: address/network, first activity, interactions, funding sources, labels + provenance, realized/unrealized performance, frequency, typical size, related-wallet hypotheses, evidence + confidence.

## 6. Engine 4 — DEX & Liquidity Intelligence
Monitors new pools, liquidity adds/removes, swaps, reserves, volume, price moves, concentrated liquidity, large LP positions/withdrawals, contract/token risk.
Liquidity-removal alert identifies: pool/DEX, initiating wallet, tx hash + block, assets/quantities, estimated value + valuation source, remaining liquidity, wallet history of similar actions.
Liquidity Risk Radar (transparent, multi-metric — never safe/unsafe on one metric): depth, concentration, recent withdrawal %, volume/liquidity, holder concentration, contract risk, pool age/activity, price impact for representative sizes.

## 7. Engine 5 — MEV & Transaction Intelligence
Patterns: potential sandwiches, arbitrage, liquidations, unusual gas bidding, repeated bundles where observable, DEX price discrepancies, large trades with high impact.
Analysis estimates pool reserves, expected impact, post-trade state, competing visible txs, sandwich resemblance, evidence sufficiency. User feature: pre-trade protection/research — slippage, impact, depth, adverse conditions. Private order flow + incomplete mempool visibility mean never exhaustive.

## 8. Engine 6 — AI Investigation Agent
AI for investigation/explanation, never for every raw event (expensive, slow, unnecessary).
Stage A deterministic detection (watchlists, thresholds, signatures, rules) → Stage B enrichment (wallet history, contract metadata, transfers, liquidity, related txs, labels+sources, historical behavior) → Stage C AI investigation on a structured evidence package.
Report must return: findings, supporting tx hashes + block numbers, confidence + why, alternative explanations, missing evidence, next steps. Never invent activity; never describe correlation as proof of ownership; distinguish facts / estimates / hypotheses.
Workflow: create record → retrieve tx+block → wallet history → related contracts/transfers → relationship graph → compare historical patterns → model summary → validate cited txs exist in evidence → store report + confidence → deliver.
Restricted read-only tools by default; no private-key / signing access.

## 9. Engine 7 — Alerts & optional execution
Channels: Telegram, Discord, dashboard, REST API, webhooks, scheduled reports. Alert format: network, event, wallet, token, tx, block, status; observed facts; assessment with risk indicators, alternatives, evidence links, confidence, missing info.
Execution safeguards (never launch with autonomous trading): simulation, max value, max slippage, allowlists, spend limits, manual approval for high-risk, kill switch, separate execution wallet, secure signing, full audit logs. Never put a private key in code, logs, prompts, or AI context.

## 10. Stack
See README table. Service layout is the repo layout of this project (apps/, services/, packages/, migrations/, infrastructure/, tests/).

## 11. Database
See database.md. Log identity: (chain_id, block_hash, transaction_hash, log_index).

## 12. Starter listener
Real viem ERC-20 Transfer listener in services/evm_listener/src/listener.ts — confirmed events only; no durable storage/backfill/reconnect/reorg/multi-chain yet.

## 13. Budget
See BUDGET.md ($200 allocation + cost controls + do-not-buy list).

## 14. Roadmap
See roadmap.md — Phases 1–7, each with goal + acceptance criteria, testable before the next begins.

## 15. Dashboard
12 pages: Overview, Live Feed, Mempool, Wallet Intelligence, Whale Radar, DEX Radar, MEV Monitor, AI Investigations, Watchlists, Alerts, System Health, Settings.

## 16. Security & reliability
Secret storage, never commit .env, never log secrets/keys, read-only RPC for monitoring, restricted AI tools, API authn/authz, webhook signature validation, rate limits, DB backups, queue-lag monitoring, admin audit logs, separate wallets/isolated signing if execution is ever added, recovery tests (RPC disconnect, DB downtime, duplicates, reorgs).

## 17. KPIs
Ingestion lag, processing lag, queue depth, RPC uptime, reconnect count, backfill duration, duplicate rate, reorg recovery time, alert delivery latency, AI cost/investigation, evidence validation rate. Set SLOs only after measuring.

## 18. Realistic MVP
Ethereum + Base; primary + secondary RPC; WS block/log listeners; HTTP backfill; PostgreSQL storage; wallet watchlists; ERC-20 transfer monitoring; basic whale thresholds; small dashboard; Telegram alerts; manually triggered AI investigation. Then DEX indexing, mempool, clustering, MEV, more networks.

## 19. Build specification
See BUILD_SPEC.md.

## 20. Final recommendation
NEXUS's value is not chain count or model count — it is turning raw activity into verified, explainable, timely intelligence. Build ingestion first, then wallet intelligence, liquidity monitoring, AI investigation. Treat mempool as an additional signal, not a complete view of the network.

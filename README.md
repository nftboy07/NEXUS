# NEXUS — Autonomous Blockchain Intelligence Network

> Deterministic software detects and processes blockchain events. AI investigates selected, enriched events. AI must not sit in the critical path of event ingestion.

Built by **Crypto Relic** ([@cryptorelic](https://github.com/nftboy07))

NEXUS is a continuously running, multi-chain blockchain intelligence platform that listens to on-chain activity, monitors visible pending transactions, analyzes wallets and liquidity, detects suspicious patterns, and produces evidence-backed alerts.

Not another basic whale tracker, Telegram bot, mempool monitor, or token scanner — one platform that combines those capabilities.

## The 7 Engines

1. **Multi-chain RPC Listener Network** — WebSocket `newHeads` / `logs` / `newPendingTransactions`, HTTP backfill, checkpoints, failover, reorg handling
2. **Mempool Intelligence** — pending swap / liquidity / deployment detection, pending-to-confirmed lifecycle tracking
3. **Smart Money & Whale Intelligence** — wallet behavioral profiles, accumulation/distribution, Smart Money Score, related-wallet hypotheses with evidence
4. **DEX & Liquidity Intelligence** — new pools, liquidity adds/removes, reserves, volume, Liquidity Risk Radar
5. **MEV & Transaction Intelligence** — sandwich / arbitrage / liquidation patterns, price-impact estimation, pre-trade protection research
6. **AI Investigation Agent** — evidence packages only, validated citations, confidence + alternative explanations, never invented activity
7. **Alerts & Optional Execution** — Telegram / Discord / dashboard / REST API; execution only after simulation, allowlists, limits, and human approval (not in MVP)

Every material finding is traceable to transaction hashes, block numbers, contract addresses, and timestamps. The listener keeps operating if an AI provider is unavailable.

## MVP (Phase 1–3 first)

- Chains: **Ethereum + Base** first, then Arbitrum + BSC
- One primary + one secondary RPC provider
- WebSocket block/log listeners + HTTP backfill
- PostgreSQL event storage, Redis Streams queue
- Wallet watchlists, ERC-20 transfer monitoring, whale thresholds
- Telegram alerts, small dashboard, manually triggered AI investigation

## Stack

| Layer | Technology |
|---|---|
| EVM listener | TypeScript + viem |
| API | Python + FastAPI |
| Queue | Redis Streams (NATS JetStream later) |
| Database | PostgreSQL (ClickHouse / Neo4j later) |
| Dashboard | Next.js |
| Deployment | Docker Compose |
| Monitoring | Prometheus + Grafana |

## Budget

Constrained prototype target: **$200 in cloud/API credits** — RPC $45 / compute $40 / DB $25 / AI $35 / monitoring $10 / reserve $45. See `docs/BUDGET.md`.

## Docs

- [Full Blueprint](docs/BLUEPRINT.md) — the complete idea, all 20 sections
- [Architecture](docs/architecture.md)
- [Roadmap](docs/roadmap.md) — Phases 1–7 with acceptance criteria
- [Database](docs/database.md)
- [Budget](docs/BUDGET.md)
- [Build Specification](docs/BUILD_SPEC.md) — instruction for AI coding agents

## Quick start (starter listener)

```bash
cd services/evm_listener
cp ../../.env.example .env   # set WSS_RPC_URL
npm install
npx tsx src/listener.ts
```

## Security

Read-only monitoring in the MVP. No private keys in code, logs, prompts, or AI context. No autonomous trading. Secrets only via environment / secret storage — never commit `.env`.

## License

MIT — see [LICENSE](LICENSE)

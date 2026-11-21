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

## Quick start

### Whole stack (Docker Compose)

```bash
cp .env.example .env   # set WSS_RPC_URL / HTTP_RPC_URL (+_BASE for Base), NEXUS_API_KEY
docker compose up -d postgres redis   # migrations/ applies on first init
docker compose up -d                  # api, dashboard, all engine daemons
# dashboard -> http://localhost:3000, API -> http://localhost:8000/health
```

Batch/CLI services run on demand, not as daemons: `mev_analyzer`
(`python src/main.py` in its venv) and `ai_investigator`
(`python src/main.py --chain 1 --tx 0x…`).

### Running the test suites

| Service | Command |
|---|---|
| evm_listener | `cd services/evm_listener && npm run typecheck && npm test` |
| mempool_listener | `cd services/mempool_listener && npm run typecheck && npm test` |
| dex_monitor | `cd services/dex_monitor && npm run typecheck && npm test` |
| shared_utils | `cd packages/shared_utils && npm run typecheck && npm test` |
| wallet_intelligence | `cd services/wallet_intelligence && .venv/Scripts/python -m pytest` |
| mev_analyzer | `cd services/mev_analyzer && .venv/Scripts/python -m pytest` |
| ai_investigator | `cd services/ai_investigator && .venv/Scripts/python -m pytest` |
| alert_dispatcher | `cd services/alert_dispatcher && .venv/Scripts/python -m pytest` |
| api | `cd apps/api && .venv/Scripts/python -m pytest` |
| dashboard | `cd apps/dashboard && npm run build && npm run lint && npm run typecheck && npm test` |

### Status (honest)

| Component | Implemented | Tested with fixtures | Live-verified |
|---|---|---|---|
| Engine 1 listener | ✅ | ✅ | ✅ `scripts/smoke.sh` (ingest, restart catch-up, dedup, no gaps, chain isolation) |
| Engine 2 mempool | ✅ | ✅ | ✅ pending txs stored from public WSS (eth + Base) |
| Engine 3 wallet intel | ✅ | ✅ | ⚠️ transfers, wallet scores (partial coverage: no prices → no realized/risk-adjusted perf) and relation hypotheses computed live on eth + Base (`scripts/smoke.sh` check 5) |
| Engine 4 DEX radar | ✅ | ✅ | ✅ pinned pools, liquidity events + reserves stored live |
| Engine 5 MEV | ✅ | ✅ | ❌ batch job, not in compose; not run live |
| Engine 6 AI investigator | ✅ | ✅ (fake provider) | ⚠️ worker auto-investigates live whale alerts (eth + Base) with the `deterministic` provider, citations validated; no real LLM run yet |
| Engine 7 dispatcher/API | ✅ | ✅ (HTTP fakes) | ⚠️ log-only delivery + API `/health` live; no real Telegram/Discord |
| Dashboard | ✅ | ✅ | ✅ production build serves 200 |
| Execution layer | design doc only | — | NOT IMPLEMENTED |

Live-verified = `bash scripts/smoke.sh` passing (0 failures) on Docker against
free public RPCs (publicnode, Ethereum + Base). All other tests are
fixture/fake based.

## Security

Read-only monitoring in the MVP. No private keys in code, logs, prompts, or AI context. No autonomous trading. Secrets only via environment / secret storage — never commit `.env`.

## License

MIT — see [LICENSE](LICENSE)

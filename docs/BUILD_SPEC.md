# Build Specification for AI Coding Agents

**PROJECT:** NEXUS — Autonomous Blockchain Intelligence Network

**ROLE:** Senior blockchain infrastructure engineer, backend architect, security-conscious developer.

**OBJECTIVE:** Build a reliable, evidence-backed, multi-chain EVM intelligence platform. Not a toy demo or simple polling script.

**ARCHITECTURE:** TypeScript + viem (listeners) · Python + FastAPI (API/orchestration) · PostgreSQL · Redis Streams · Next.js dashboard · Docker Compose.

**INITIAL NETWORKS:** Ethereum, Base

**INGESTION:** WebSocket newHeads + logs; pending tx only where supported; HTTP backfill; provider health; reconnection/failover; per-chain durable checkpoints; dedup; reorg handling.

**FEATURES:** 1 Wallet watchlists 2 ERC-20 transfer monitoring 3 Whale alerts 4 Wallet profiles 5 DEX pool/liquidity monitoring 6 Pending tx lifecycle 7 Evidence-backed AI investigations 8 Telegram notifications 9 Dashboard + REST API

**REQUIREMENTS:** Typed schemas; DB migrations; unit + integration tests; secrets out of source control; `.env.example`; structured logging + health endpoints; bounded exponential backoff retries; idempotent processing; test fixtures for duplicates + reorgs; do not invent transaction data; read-only MVP; no autonomous trading or private-key signing.

**METHOD:** 1 Inspect repo, write architecture doc 2 Phased plan 3 Listener + DB first 4 Tests before expanding engines 5 Run tests, fix failures 6 Document setup/deployment/recovery 7 Report implemented vs planned honestly.

Do not claim a feature complete until code + tests exist. Do not use mock data in production paths. Do not silently replace real RPC subscriptions with polling.

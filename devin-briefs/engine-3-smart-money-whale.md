# Devin Brief — Engine 3: Smart Money & Whale Intelligence

You are building **Engine 3 of NEXUS** in the GitHub repo **nftboy07/NEXUS** (branch off `main`). This brief is self-contained: everything you need is below or in the repo files it names.

## Project context (read first, in this order)

NEXUS — Autonomous Blockchain Intelligence Network, by **Crypto Relic**. Deterministic software detects and processes on-chain events; AI investigates selected, enriched events only (Engine 6 — never this one). Every finding must trace to tx hashes, block numbers, contract addresses, and timestamps.

Read these repo files before writing code:

- `README.md`
- `docs/BLUEPRINT.md` — §5 (Engine 3: behavioral profiles, cluster rules, Smart Money Score)
- `docs/BUILD_SPEC.md` — binding build rules for all agents
- `docs/architecture.md`
- `docs/database.md` and `migrations/001_init.sql` — `wallets`, `wallet_transfers`, `watchlists`, `alerts` tables already exist
- `docs/roadmap.md` — Phase 3 acceptance criteria
- `packages/event_schemas/event.schema.json`, `packages/chain_config/chains.json`, `.env.example`
- `services/evm_listener/` — Engine 1's service. **Dependency:** you consume Engine 1's normalized events from the Redis stream `nexus:events` and its Postgres tables. If Engine 1's PR has not merged yet, build against the contracts named here with recorded fixtures and say so in your PR description.

**Stack:** Python 3.12 (this engine is a Python worker, matching the API side of the stack) · PostgreSQL 16 · Redis Streams.

**Chains:** Ethereum (1) and Base (8453) live; Arbitrum/BSC config-only. No hardcoded chain behavior.

**Shared contracts you must honor:**

- Input: `NexusNormalizedEvent` objects from Redis stream `nexus:events` (transfer events first; consume with a Redis consumer group so restarts resume, never reprocess).
- Alert output: rows in the `alerts` table **and** alert records on Redis stream `nexus:alerts` for Engine 7's dispatcher. An alert record carries: source engine, kind, `chain_id`, title, facts (tx hashes, block numbers, addresses, amounts), and a `dedup_key`.
- **Migration number assigned to this engine: `migrations/003_wallet_intelligence.sql`.** Never edit `001_init.sql`; never use another engine's number.

## Standing rails (non-negotiable)

- **$0 spend.** No paid data, labels, or APIs. Wallet labels come only from the `wallets` table (`label` + `label_source`) or config files in the repo — never from a purchased dataset, and never invented.
- **No secrets in code.** Env vars only. Read-only: no signing, no transaction submission, no trading.
- **Deterministic only.** No LLM calls anywhere in this engine. Scoring is transparent math with the weights published in the code and docs.
- **Brand:** user-facing strings say "Crypto Relic" / "NEXUS by Crypto Relic" only.
- **Hypotheses are not proof.** A shared funding source is a clue, not evidence of common ownership (BLUEPRINT §5). Related-wallet output is always labeled a *hypothesis*, always ships with its evidence **and** alternative explanations (exchange batching, common infrastructure, coincidence). Never write "same owner", "controlled by", or equivalent anywhere in output.
- **Small reviewable PR.** Branch `devin/engine-3-smart-money` off `main`. Do not edit `docs/BLUEPRINT.md` or `migrations/001_init.sql`. Do not merge your own PR. Report implemented vs planned honestly, with test commands and output.
- **Definition of done (BUILD_SPEC):** code + tests pass; typed schemas (pydantic models for events/profiles/scores); structured logging; idempotent processing (replaying the stream changes no state twice); no mock data in production paths.

## Engine goal

Turn the confirmed transfer stream into behavioral wallet intelligence: persisted wallet profiles, whale-threshold alerts with evidence, accumulation/distribution detection, a transparent Smart Money Score, and evidence-backed related-wallet hypotheses — every output traceable to stored on-chain evidence (roadmap Phase 3 acceptance: *every alert traces to stored on-chain evidence*).

## Exact deliverables

### `services/wallet_intelligence/` (new Python package)

- `requirements.txt` — `redis`, `psycopg[binary]`, `pydantic`, `pytest` (pin minimum versions in the style of `apps/api/requirements.txt`).
- `src/models.py` — pydantic models: `NormalizedEvent` (subset you consume), `WalletProfile`, `ScoreComponents`, `RelationHypothesis`, `AlertRecord`.
- `src/consumer.py` — Redis Streams consumer group on `nexus:events`; processes `transfer` events; ack only after DB commit; dead-letter behavior: after 3 failed attempts, log + park the event id in a `wallet_intelligence_deadletter` Redis list (never silently drop).
- `src/transfers.py` — persist each transfer to `wallet_transfers` (idempotent on `(chain_id, tx_hash, token, sender, recipient, amount)` — add a unique index in your migration if needed); upsert `wallets.first_seen`; maintain per-wallet counters used by profiles.
- `src/profiles.py` — build/refresh `WalletProfile`: address + chain, first activity, tx counts, total in/out per token, top counterparties, funding sources (first inbound senders), failed-tx count where observable, typical tx size, activity frequency. Every field derived from stored rows — a field with no data is `null`, never estimated silently.
- `src/whale.py` — threshold rules: native-value threshold from env `WHALE_THRESHOLD_ETH` (already in `.env.example`, default 100) plus per-watchlist thresholds from the `watchlists` table. A crossing emits an `AlertRecord` (kind `whale_transfer`) with full evidence (tx hash, block, from/to, token, amount, valuation source stated — if no price source is configured, report token units and say so; never invent a USD value).
- `src/accumulation.py` — deterministic accumulation/distribution detection over a rolling window (default 7 days, env-configurable): net inflow/outflow per wallet+token, buy/sell counts on known DEX pools where Engine 4 data exists (degrade gracefully to transfer-only signals when it does not, and label which signals were used).
- `src/scoring.py` — Smart Money Score, weights exactly as BLUEPRINT §5 (starting weights, labeled unvalidated in code + docs): realized performance 30%, risk-adjusted performance 20%, early discovery 20%, consistency 15%, behavioral reliability 15%. Each component is a pure function returning `(value | None, evidence)`. Components with insufficient data return `None`; the composite is reported **with its coverage** (which components contributed) — never fabricate a full score from partial data.
- `src/clusters.py` — related-wallet hypotheses. A hypothesis is emitted **only when at least two independent signal types** are present among: shared funding source; same-token purchases within a time window; direct prior interaction; repeated similar timing/size pattern. Output: the two addresses, the signals with their evidence (tx hashes/blocks), a confidence level, and mandatory alternative explanations (at minimum: exchange batching, common infrastructure). One signal alone → no output.
- `src/alerts.py` — writes `AlertRecord`s to the `alerts` table and `nexus:alerts` stream; `dedup_key` = engine + kind + primary tx hash, so the same event can never alert twice.
- `src/main.py` — worker entrypoint: consumer loop, periodic profile/score refresh, structured JSON logging, heartbeat log line every minute.
- `migrations/003_wallet_intelligence.sql` — `wallet_scores` (`address`, `chain_id`, `score`, `coverage JSONB`, `components JSONB`, `computed_at`; PK `(address, chain_id)`) and `wallet_relations` (`address_a`, `address_b`, `chain_id`, `signals JSONB`, `confidence`, `alternatives JSONB`, `created_at`; PK `(address_a, address_b, chain_id)`), plus any index you need on `wallet_transfers`.
- Replace `services/wallet_intelligence/README.md` stub with real setup/run docs, including the scoring weights and the hypothesis language rules.

### Tests (`services/wallet_intelligence/tests/`, pytest)

- `test_scoring.py` — fixture wallet histories → expected component values; a wallet with no realized-performance data gets `realized_performance = None` and a reduced-coverage composite, not a made-up number.
- `test_clusters.py` — single-signal pair → **no** hypothesis; two-signal pair → hypothesis containing evidence + alternatives, and the word "hypothesis" in its serialized form.
- `test_whale.py` — transfer exactly at threshold alerts; one wei below does not; replaying the same event produces exactly one alert (dedup).
- `test_profiles.py` — fixture transfer set → profile fields match hand-computed values.
- `fixtures/` — recorded transfer-event JSON sets with provenance labeled in `fixtures/README.md`.
- An end-to-end replay test: fixture events → expected `wallet_transfers` rows, one whale alert record, one profile, one score row.

## Acceptance checks (all must pass; paste output in the PR)

```bash
cd services/wallet_intelligence
pip install -r requirements.txt
pytest
```

Plus the end-to-end replay above, run against local Postgres + Redis from `docker-compose.yml`, with its printed alert record shown in the PR description — the alert must contain a real fixture tx hash and block number, and the score output must show its coverage.

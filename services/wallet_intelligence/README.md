# wallet_intelligence — Engine 3 (Smart Money & Whale Intelligence)

Python 3.12 worker. Consumes confirmed `log`/`transfer` events from the Redis
stream `nexus:events` via a consumer group, decodes ERC-20 `Transfer` logs into
`wallet_transfers`, builds behavioral profiles, emits whale/watchlist alerts,
computes Smart Money Scores, and forms related-wallet **hypotheses**.

Deterministic only — no LLM calls, no price feeds, no signing, no external
label datasets. Labels come solely from the `wallets` table.

## Setup

```bash
cd services/wallet_intelligence
python -m venv .venv
# Git Bash:
source .venv/Scripts/activate
pip install -r requirements.txt   # redis>=5.0, psycopg[binary]>=3.1, pydantic>=2.5, pytest>=8.0
pytest
```

## Run

```bash
export REDIS_URL=redis://localhost:6379
export DATABASE_URL=postgresql://nexus:nexus@localhost:5432/nexus
python src/main.py
```

Env: `WHALE_THRESHOLD_ETH` (default `100`), `CONSUMER_NAME`
(`wallet-intel-1`), `ACCUMULATION_WINDOW_DAYS` (`7`), `SCORE_REFRESH_SECONDS`
(`300`), `LOG_LEVEL`.

Requires `migrations/001_init.sql` + `003_wallet_intelligence.sql`
(wallet_scores, wallet_relations, wallet_transfers dedup index).

## Scoring weights (UNVALIDATED starting weights — validate historically)

| component | weight |
|---|---|
| realized performance | 30% |
| risk-adjusted performance | 20% |
| early discovery | 20% |
| consistency | 15% |
| behavioral reliability | 15% |

Every component is a pure function returning `(value 0..1 | None, evidence)`.
Insufficient data → `None`, never a fabricated number. The composite is
renormalized over contributing components and reports `coverage`.
`realized_performance` returns `None` on transfers-only data (realized PnL
needs sale prices; none configured).

## Whale alerts

`WHALE_THRESHOLD_ETH` applies to WETH transfers (the on-chain ETH proxy) at
threshold equality (`>=`); one wei below does not alert. Watchlists add
`wallet` and `min_amount` (`<token>:<amount>`) rules. Alert facts include tx
hash, block, sender/recipient, token, amount and the valuation source — token
units, with no external price source.

## Score / relation refresh (live)

Every `SCORE_REFRESH_SECONDS` the worker refreshes **every chain present in
`wallet_transfers`** (not just chain 1): one O(rows) pass scores every wallet
and commits, then the relation pass runs and commits separately. While the
table is still empty the refresh retries every 30 s, so the first scores
appear one interval after transfers start. A failing chain is rolled back and
logged (`score refresh failed`); it never stops the consumer loop. Each run
logs `score refresh` with transfers, wallets, wallets_with_score, relations,
candidate_pairs, hub_groups_skipped and timings.

No watchlist is required: scores and relations are computed from stored
transfers alone (watchlists only add whale-alert rules).

Relations evaluate only candidate pairs that share a funder, a direct
transfer, or a same-token block bucket (any ≥2-signal pair has one of these,
so none is missed). Groups larger than `MAX_GROUP_SIZE` (50) — routers, the
mint address, a token bucket with hundreds of recipients — are not expanded
into pairs (that is the "common infrastructure" alternative, not a clue);
those pairs can still surface via a direct transfer.

## Hypothesis language rules

A relation is emitted only with ≥2 independent signal types (shared funding
source, same-token transfers within a block window, direct prior interaction,
repeated similar timing/size). Signals must be independent: `same_token_window`
only counts inbound pairs from two distinct senders, excluding both wallets and
any shared funder, so one sender paying both wallets (or a direct a→b transfer)
is never counted twice. Output always includes evidence (tx hashes) and
alternative explanations (exchange batching, common infrastructure,
coincidence), serialized as `related_wallet_hypothesis`. Never "same owner" or
"controlled by".

## Recovery / idempotency

Redis consumer group `wallet_intelligence` acks only after a committed DB
transaction; on restart `recover()` reclaims stale pending entries, and after
`max_retries` (3) an event id is parked in the `wallet_intelligence_deadletter`
list — never silently dropped. Transfers are deduped by a unique index on
`(chain_id, tx_hash, token, sender, recipient, amount)`; alerts by
`source:kind:tx_hash` dedup key, so replaying the stream produces each row and
alert exactly once.

## Tests

`pytest` covers whale thresholds (boundary + dedup), scoring (coverage, no
fabrication), clusters (1 signal → nothing, 2 signals → hypothesis +
alternatives), profiles (hand-computed), transfer decode/idempotency, and a
full fixture replay. Live Postgres/Redis smoke was **not** run (Docker
unavailable); tests use in-memory fakes over the same interfaces.

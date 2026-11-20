# NEXUS — Devin Session Brief Pack

**Purpose:** paste-ready briefs for building NEXUS's 7 engines in parallel Devin sessions. One brief = one Devin session = one engine = one PR (Engine 7 is two PRs). Each brief is self-contained: it names the repo files to read, the exact files/modules to create, the acceptance checks that prove it works, and the standing rails.

**Repo:** `nftboy07/NEXUS` (public, `main` branch) · **Project:** NEXUS — Autonomous Blockchain Intelligence Network, by Crypto Relic.

## How to use this pack

1. Connect Devin to the GitHub account that owns `nftboy07/NEXUS` (owner does this himself — one OAuth tap).
2. Open one Devin session per engine, in the wave order below. Paste the brief file's full contents as the session's first message.
3. Each session branches off `main`, builds, runs its acceptance checks, and opens its PR. **Devin never merges — the owner reviews and merges every PR.**
4. Start the next wave only after the previous wave's PRs are merged (the briefs say what to do if a dependency hasn't merged: build against the named contracts with fixtures, and flag it in the PR).

**Time pressure:** Devin Max is a free month expiring **~mid-December 2026**. Waves 0 and 1 are the priority — they produce a running listener feeding wallet + DEX intelligence, which is the demonstrable core of NEXUS. Waves 2–3 can continue on other tooling if the month runs out.

## The briefs

| # | Engine | Brief file | Service dir | Language | Migration | Branch |
|---|---|---|---|---|---|---|
| 1 | Multi-chain RPC Listener Network | `engine-1-rpc-listener.md` | `services/evm_listener/` | TypeScript + viem | — (uses `001`) | `devin/engine-1-rpc-listener` |
| 2 | Mempool Intelligence | `engine-2-mempool.md` | `services/mempool_listener/` | TypeScript + viem | `002_pending_transactions.sql` | `devin/engine-2-mempool` |
| 3 | Smart Money & Whale Intelligence | `engine-3-smart-money-whale.md` | `services/wallet_intelligence/` | Python | `003_wallet_intelligence.sql` | `devin/engine-3-smart-money` |
| 4 | DEX & Liquidity Intelligence | `engine-4-dex-liquidity.md` | `services/dex_monitor/` | TypeScript + viem | `004_pool_reserves.sql` | `devin/engine-4-dex-liquidity` |
| 5 | MEV & Transaction Intelligence | `engine-5-mev.md` | `services/mev_analyzer/` | Python | `005_mev_findings.sql` | `devin/engine-5-mev` |
| 6 | AI Investigation Agent | `engine-6-ai-investigation.md` | `services/ai_investigator/` | Python | `006_investigations_detail.sql` | `devin/engine-6-ai-investigation` |
| 7 | Alerts & Optional Execution | `engine-7-alerts-execution.md` | `services/alert_dispatcher/`, `apps/api/`, `apps/dashboard/` | Python + Next.js | — (uses `001`) | `devin/engine-7-alerts-api`, then `devin/engine-7-dashboard` |

## Sequencing — waves and parallelism

```
Wave 0 (first, alone):        Engine 1 — RPC Listener
                               Everything consumes its events, tables, checkpoints,
                               and shared TS packages. Nothing else merges before it.

Wave 1 (parallel, after E1):   Engine 3 — Smart Money & Whale   (consumes nexus:events)
                               Engine 4 — DEX & Liquidity       (consumes nexus:events)
                               Engine 2 — Mempool               (reuses E1 clients/packages;
                               independent subscription path)

Wave 2 (parallel, after Wave 1):
                               Engine 5 — MEV                   (needs E2 lifecycle + E4 reserves)
                               Engine 6 — AI Investigation      (needs E1 data; E3 enrichment
                               when available — can start on E1-only evidence)
                               Engine 7 PR-A — Alerts + API     (formatter/API can be drafted
                               in Wave 1 against the alert contract; delivery wiring
                               completes once producers exist)

Wave 3 (after PR-A merges):    Engine 7 PR-B — Dashboard
```

**Parallel-safe:** E2 + E3 + E4 run fully in parallel in Wave 1 (different services, different languages, pre-assigned migration numbers). E5 + E6 + E7-A run in parallel in Wave 2.
**Not parallel:** E1 must land first. E5 must not start integration before E2 and E4 merge (its sandwich detection reads their tables). E7-B waits for E7-A's API.

## Shared contracts (every brief repeats its piece; this is the canonical list)

- **Normalized events:** `packages/event_schemas/event.schema.json` (`NexusNormalizedEvent`; `dedup_key` = `chain_id:block_hash:tx_hash:log_index` for logs).
- **Redis Streams:** `nexus:events` (E1 produces; E3, E4 consume) · `nexus:pending` (E2) · `nexus:alerts` (E2–E5 produce alert records; E7 consumes).
- **Alert records:** pinned as `packages/event_schemas/alert.schema.json` by Engine 7 PR-A; producers emit `{source_engine, kind, chain_id, title, facts{}, assessment{}, dedup_key, created_at}` and a matching row in the `alerts` table.
- **Database:** `migrations/001_init.sql` is applied and frozen. Schema changes only via the pre-assigned migration numbers in the table above — this is what keeps parallel PRs conflict-free. Log identity: `(chain_id, block_hash, transaction_hash, log_index)`.
- **Chains:** Ethereum (1) + Base (8453) live; Arbitrum (42161) + BSC (56) config-only in `packages/chain_config/chains.json`. All chain behavior is config-driven.
- **Log filters:** `packages/chain_config/log_filters.json` (created by E1, extended by E4) decides what the listener subscribes to.
- **Config:** everything via env vars in `.env.example`. Nobody commits a `.env`.

## Standing rails (in every brief — summary)

- **$0 spend.** No paid services, APIs, or datasets; free public RPCs or recorded fixtures for dev/test. Total prototype budget is $200 in credits (`docs/BUDGET.md`) and none of it is spent by coding sessions.
- **No secrets or API keys in code** — env vars only, never in code/tests/fixtures/logs/prompts. **No private keys anywhere; read-only monitoring; no signing, no trading.** Engine 7's execution layer is a design document only.
- **Deterministic detection; AI only in Engine 6's investigation layer.** Every other engine works with no LLM configured, and ingestion never depends on the AI service.
- **Brand "Crypto Relic" only** in user-facing strings, messages, and docs.
- **Evidence or it didn't happen:** findings trace to tx hashes, block numbers, addresses, timestamps; facts / estimates / hypotheses are always labeled distinctly; pending (mempool) activity is never presented as confirmed; wallet clusters are hypotheses with alternative explanations, never ownership claims.
- **Small reviewable PRs against `main`**, one engine per PR, honest implemented-vs-planned reporting with test output in the PR description. No PR edits `docs/BLUEPRINT.md` (canonical) or `migrations/001_init.sql`.

## Owner review checklist (per PR, ~5 minutes)

1. Acceptance commands from the brief were run and their output is in the PR description.
2. Tests include the negative cases the brief demands (dedup, insufficient evidence, fabricated citation, below-threshold).
3. No `.env`, no keys/tokens/URLs with keys, no `private_key`/`sign_transaction` strings anywhere in the diff.
4. Diff touches only that engine's service dir + its assigned migration + the shared files its brief names.
5. Service README is real documentation now, not the "Planned service" stub.
6. Claims match code: nothing marked complete without a test proving it.

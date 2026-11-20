# ai_investigator — Engine 6 (AI Investigation)

The only NEXUS service that may call an LLM — and never in the critical
path: every other engine keeps working when this service or the provider
is down. Manual CLI trigger only in the MVP.

## How it works

1. `package.py` builds an `EvidencePackage` for `(chain_id, tx_hash)`
   entirely from stored rows (transactions, blocks, logs,
   wallet_transfers, wallets labels **with sources**, Engine 3
   scores/hypotheses when present — each tagged with provenance).
   Anything absent lands in `missing`; nothing is filled in. The package
   carries a `citable` index: the exact `(tx_hash, block_number)` pairs a
   report may cite.
2. `investigate.py` inserts an `investigations` row
   (`status='package_built'`).
3. No `LLM_API_KEY`/`LLM_MODEL` → `status='awaiting_model'`, exit 0 —
   package-only mode, zero HTTP calls.
4. Otherwise one LLM request (`PROMPT.md` + package JSON, 60s timeout,
   one retry) → parsed against `InvestigationReport` → `validate.py`
   mechanically rejects citations absent from the package's citable index
   and `fact` findings without a valid citation. `complete` or
   `validation_failed` (stored for audit, flagged `unverified`, never
   presented as verified). Schema-invalid output → `report_invalid` with
   raw output preserved.
5. `cost.py` records token usage; `cost_estimate` only when
   `LLM_PRICE_INPUT_PER_MTOK`/`LLM_PRICE_OUTPUT_PER_MTOK` are set — else
   NULL, never invented.

## Run

```bash
pip install -r requirements.txt
export DATABASE_URL=... LLM_API_KEY=... LLM_MODEL=...
python src/main.py --chain 1 --tx 0x...
python src/main.py --chain 1 --address 0x...   # most recent stored tx
python src/main.py --worker                    # daemon: consume 'queued' rows (POST /investigations)

Worker mode claims rows atomically (FOR UPDATE SKIP LOCKED — N workers
never process the same row), requeues 'awaiting_model' rows at startup
when a model is configured, and requeues 'running' claims stale >10min.
INVESTIGATOR_POLL_SECONDS sets the idle poll interval (default 10).
```

Migration: `006_investigations_detail.sql` adds report/citations_valid/
tokens/cost/model/chain_id/trigger_tx columns to `investigations`.

## Secrets

The API key is read from env per call and never appears in packages,
prompts, logs, or stored fields (asserted by `test_secrets.py`). No
signing capability exists anywhere in this service.

## Tests

`pytest` — citation validation (valid, fabricated-hash, fact-without-
citation, schema-invalid), package contents + missing-tx, package-only
mode with a transport spy, key hygiene. No live LLM calls anywhere.

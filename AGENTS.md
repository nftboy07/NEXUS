# AGENTS.md — build & test commands for every service

Repo: NEXUS (Crypto Relic). Node 22 + npm workspaces at repo root
(`npm install` once at root for all TS services); Python services use
per-service virtualenvs (`python -m venv .venv` inside the service dir,
then `.venv/Scripts/python -m pip install -r requirements.txt` — Windows;
`.venv/bin/python` on Unix).

## TypeScript services (vitest)

| Service | Path | Commands |
|---|---|---|
| EVM listener (Engine 1) | services/evm_listener | `npm run typecheck` / `npm test` |
| Mempool listener (Engine 2) | services/mempool_listener | `npm run typecheck` / `npm test` |
| DEX monitor (Engine 4) | services/dex_monitor | `npm run typecheck` / `npm test` |
| Shared utils | packages/shared_utils | `npm run typecheck` / `npm test` |

## Python services (pytest, from the service dir)

| Service | Path | Command |
|---|---|---|
| Wallet intelligence (Engine 3) | services/wallet_intelligence | `.venv/Scripts/python -m pytest` |
| MEV analyzer (Engine 5) | services/mev_analyzer | `.venv/Scripts/python -m pytest` (batch run: `python src/main.py`) |
| AI investigator (Engine 6) | services/ai_investigator | `.venv/Scripts/python -m pytest` (CLI: `python src/main.py --chain 1 --tx 0x…`) |
| Alert dispatcher (Engine 7) | services/alert_dispatcher | `.venv/Scripts/python -m pytest` |
| API | apps/api | `.venv/Scripts/python -m pytest` (run: `uvicorn main:app --port 8000`) |

## Dashboard (Next.js)

```bash
cd apps/dashboard
npm install
npm run build      # production build (required acceptance)
npm run lint       # next lint — zero warnings/errors expected
npm run typecheck  # tsc --noEmit
npm test           # vitest component/unit tests
```

## Migrations

`migrations/*.sql` apply in numeric order via the postgres
`docker-entrypoint-initdb.d` mount on a **fresh volume only**; apply
manually with `psql -f` on existing volumes. All migrations must be
idempotent. Next free number: **013**.

## Rails

Deterministic, evidence-backed; no secrets in code/logs/prompts;
`EXECUTION_ENABLED` stays false — no signing or tx submission exists;
don't edit `docs/BLUEPRINT.md` or `migrations/001_init.sql`; commits on
`main` carry the Devin trailer; do not push.

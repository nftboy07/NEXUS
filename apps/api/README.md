# NEXUS API — read-only monitoring API (Engine 7, Crypto Relic)

FastAPI app. `GET /health` and `/chains` are public; everything else
requires the `X-Api-Key` header compared against `NEXUS_API_KEY` via a
hashed constant-time check — the key is never logged or returned.

## Endpoints

- `GET /health` — status + checkpoint rows per chain
- `GET /chains` — chains.json-driven (ethereum, base; arbitrum/bsc planned)
- `GET /alerts`, `GET /alerts/{id}` — persisted alerts + delivery state
- `POST /watchlists` (`kind`, `value`, `note`), `GET`, `DELETE /watchlists/{id}`
- `GET /wallets/{address}` — Engine 3 composite score (404 if untracked)
- `GET /events?chain_id=` — recent stored logs

```bash
pip install -r requirements.txt
export DATABASE_URL=... NEXUS_API_KEY=...
uvicorn main:app --port 8000
pytest  # TestClient suite: auth, watchlists, wallets, health
```

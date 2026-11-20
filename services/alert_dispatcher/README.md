# alert_dispatcher — Engine 7 (Alert Dispatcher)

Consumer-group worker on `nexus:alerts`. Contract pinned by
`packages/event_schemas/alert.schema.json` (+ `src/models.py`): producers
publish a JSON record with `source_engine`, `kind`, `chain_id`, `facts`,
optional `assessment`, `dedup_key`; dispatcher validates (pydantic),
formats (Facts and Assessment as separate sections — a `No assessment
supplied` notice when absent, never invented), and delivers.

Mempool-sourced records (`source_engine: mempool_listener`) are labeled
`PENDING` in the message header — pending intelligence is never styled
as confirmed.

## Channels

| Channel | Env | Behavior |
|---|---|---|
| Telegram | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Bot API `sendMessage`; unset -> log-only `skipped_no_config`, never blocks others |
| Discord | `DISCORD_WEBHOOK_URL` | webhook POST; unset -> log-only |
| Signed webhooks | `ALERT_WEBHOOK_URLS`, `WEBHOOK_SECRET` | `X-Nexus-Signature: sha256=<hmac>`; unsigned alerts are never sent |

Retry: up to 3 attempts (exponential backoff) on transport errors only.
Dedup by `dedup_key` — a `sent` record is acked without redelivery.
Delivery states persisted on the alerts row: `pending` / `sent` /
`failed` / `skipped_no_config`. One channel's failure never blocks the
others. Invalid stream records are logged and parked (acked) — never
crash the loop.

## Run

```bash
pip install -r requirements.txt
export DATABASE_URL=... REDIS_URL=...
python src/main.py
```

`pytest` covers formatting (facts/assessment separation, PENDING label),
HMAC signature, unconfigured-channel skips, bounded retry, dedup, and
malformed-record parking — all with HTTP fakes; no real messages.

No signing keys, no transaction submission, no secrets in logs.

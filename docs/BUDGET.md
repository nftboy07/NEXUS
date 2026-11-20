# $200 Credit Deployment Strategy

Constrained prototype budget — not a promise a production-scale multi-chain system runs indefinitely for $200. Credit coverage differs by provider; some credits cannot pay third-party APIs.

| Area | Target | Use |
|---|---|---|
| RPC / data provider | $45 | Managed RPC, subscriptions, limited webhooks |
| VPS / compute | $40 | Listener, API, workers |
| Database / storage | $25 | PostgreSQL + backups |
| AI inference | $35 | Selected investigations + summaries |
| Monitoring / delivery | $10 | Logs, metrics, notifications |
| Reserve | $45 | Unexpected usage + testing |
| **Total** | **$200** | |

Cost controls: filter events before AI; deterministic rules for routine monitoring; batch enrichment; cache metadata/decimals; avoid refetching wallet history; store only needed data; provider spend alerts + limits; reserve for RPC spikes; no archive nodes in initial budget.

Do NOT buy initially: dedicated H100 GPU, multiple archive nodes, enterprise Kafka, large vector DB, overlapping LLM subscriptions, expensive datasets before validating demand.

# NEXUS Architecture

```
                    BLOCKCHAIN NETWORKS
             Ethereum / Base / Arbitrum / BSC
                            |
             +--------------+--------------+
             |              |              |
          RPC WS         Webhooks       HTTP RPC
       newHeads/logs    provider data   backfill/lookups
             |              |              |
             +--------------+--------------+
                            |
                  EVENT INGESTION LAYER
             validate / normalize / deduplicate
                   retry / checkpoint / queue
                            |
                   EVENT PROCESSING CORE
             decode / enrich / correlate / classify
                            |
       +----------+---------+---------+----------+
       |          |         |         |          |
     Wallet     Whale      DEX      Mempool     MEV
 Intelligence  Signals  Liquidity  Analysis  Patterns
       |          |         |         |          |
       +----------+---------+---------+----------+
                            |
                  AI INVESTIGATION AGENT
             evidence gathering / explanations
                confidence / alternative causes
                            |
                 ALERTS AND USER INTERFACES
           Dashboard / Telegram / Discord / REST API
                            |
                  OPTIONAL EXECUTION LAYER
             simulation / allowlists / limits / approval
```

## Data flow

1. A blockchain provider streams a new block, log, or pending transaction notification.
2. Ingestion validates the message and identifies network + source.
3. The event is normalized into a common internal format.
4. A deduplication key prevents duplicate processing.
5. The event is placed on a durable queue (Redis Streams initially).
6. Specialized workers decode and enrich it.
7. Rules and scoring decide whether it is interesting.
8. Selected events go to the AI investigation agent.
9. Evidence-backed findings are stored and delivered.
10. Checkpoints allow recovery after outages.

## Core principle

Deterministic software detects and processes events. AI investigates selected, enriched events only. The listener continues if AI is unavailable.

## Failover

If the primary provider disconnects at block N:
1. Detect broken WebSocket. 2. Reconnect with exponential backoff.
3. Switch to secondary provider if necessary. 4. Read last durable checkpoint.
5. Backfill missing range via HTTP RPC. 6. Deduplicate recovered events.
7. Resume live subscriptions. 8. Record outage + recovery in health metrics.

Never assume reconnecting a WebSocket recovers missed events.

## Reorganization handling

Store block hashes + parent hashes, not only numbers. Track confirmation depth per chain. If a log is marked removed or its block is no longer canonical, reverse/invalidate derived state and recalculate affected results.

## Provider strategy

| Source | Role |
|---|---|
| Primary managed RPC | Main WebSocket + HTTP |
| Secondary managed RPC | Failover + independent comparison |
| Webhook/stream provider | Managed filtered delivery |
| Self-hosted node | Optional, when economical |
| Public RPC | Development only |

Evaluate: Alchemy, QuickNode, Tenderly, Blocknative — verify current plans, chain coverage, subscription/webhook/mempool features and rate limits on the chosen tier before committing.

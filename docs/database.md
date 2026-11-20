# Database Design (PostgreSQL first)

Add ClickHouse or a graph DB only when volume/queries justify it.

| Table | Contents |
|---|---|
| chains | Chain IDs, names, RPC config references |
| blocks | Block number, hash, parent hash, timestamp |
| transactions | Hash, sender, recipient, value, status |
| logs | Contract address, topics, data, log index |
| wallets | Address, labels, first-seen |
| wallet_transfers | Token, sender, recipient, amount |
| tokens | Contract, symbol, decimals, metadata source |
| pools | DEX, pair, token addresses |
| liquidity_events | Pool, event type, amounts |
| watchlists | User wallet/contract watches |
| investigations | Trigger, evidence, findings, status |
| alerts | Destination, message, delivery state |
| checkpoints | Last processed block + cursor per chain |
| provider_health | Latency, errors, availability |

Unique constraint for an EVM log identity: `(chain_id, block_hash, transaction_hash, log_index)`. Handle canonical-chain changes explicitly. Migrations live in `/migrations`.

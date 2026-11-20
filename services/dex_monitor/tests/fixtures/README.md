# Test fixtures — REAL recorded logs

`raw_logs.json` contains real `eth_getLogs` results captured on 2026-11-20 via
public RPC endpoints (ethereum-rpc.publicnode.com, base-rpc.publicnode.com).
These are real on-chain events — not synthetic. Provenance per entry:

| key | chain | what | block | tx |
|---|---|---|---|---|
| `v2_pair_created` | Ethereum (1) | Uniswap V2 factory `0x5C69…aA6f` `PairCreated` | 26452553 | `0x1b4aa7e85f8143914962df226e7825be5548f39a60bf3fde3b8414f716368a4a` |
| `v2_swap` | Ethereum (1) | USDT/WETH UniV2 pair `0x0d4a…1852` `Swap` | 26455428 | `0x808f25475fca2a67…` (see file) |
| `v2_sync` | Ethereum (1) | same pair, `Sync` | 26455428 | same tx |
| `v2_mint` | Ethereum (1) | same pair, `Mint` | 26453197 | `0xc341afbc7ed8c79b…` (see file) |
| `v2_burn` | Ethereum (1) | same pair, `Burn` | 26453197 | same tx |
| `v3_pool_created` | Ethereum (1) | Uniswap V3 factory `0x1F98…984` `PoolCreated` | 26454111 | `0xe6d73c516e07404c…` (see file) |
| `base_v3_pool_created` | Base (8453) | Uniswap V3 factory `0x3312…DfD` `PoolCreated` | 59854043 | `0x0b8b863fb8402f27…` (see file) |

Verify any entry with `eth_getTransactionReceipt` / `eth_getLogs` against the
stated chain, block, and tx hash. Synthetic events (clearly labeled) are only
used in `alerts.test.ts` / `risk.test.ts` where controlled amounts are needed.

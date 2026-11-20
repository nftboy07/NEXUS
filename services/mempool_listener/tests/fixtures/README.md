# Fixture provenance

`pending_txs.json` — **real recorded transactions** fetched from Ethereum
mainnet via `https://eth.drpc.org` (free public RPC) around the block recorded
in `recorded_block`. For each entry the raw `input` calldata, `to`, `from`,
`value`, `nonce`, `blockNumber` and `hash` were captured verbatim from
`eth_getBlockByNumber`/`eth_getTransactionByHash` — the same RPC fields the
pending fetcher consumes (`eth_getTransactionByHash` on a pending hash returns
the identical shape minus block fields).

Included methods: Uniswap V2 `swapExactTokensForTokens`,
`swapExactETHForTokens`, `addLiquidity`, `addLiquidityETH`; Uniswap V3
`exactInputSingle`, `exactInput`, `increaseLiquidity`; ERC-20 `transfer`,
`approve`; plus a contract-deployment transaction (`to: null`, input
truncated with its true length recorded).

These transactions are included on mainnet; the tests replay them as *pending*
candidates purely for decode coverage. Lifecycle fixtures in the tests
(checkpoint/block sequences) are synthetic and are labeled as such in the
test files.

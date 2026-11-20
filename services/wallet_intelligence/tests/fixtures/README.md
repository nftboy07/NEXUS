# Fixture provenance

`transfers.json` — **synthetic, clearly labeled** normalized events in the
Engine 1 `nexus:events` schema. They exercise four cases end-to-end:

1. A 100 WETH `Transfer` log (topic0 `0xddf252…`, contract
   `0xc02aaa39…c756cc2`, data `0x56bc75e2d63100000` = 100·10¹⁸) — the
   `WHALE_THRESHOLD_ETH` boundary case.
2–3. Two transfers where `0xf1` funds `0xaa1` and `0xaa2` (shared funding
   source signal).
4. A direct `0xaa1 → 0xaa2` transfer (second independent signal, so a
   related-wallet hypothesis forms).

These are authored fixtures, not recorded chain data — no real wallets,
no real tx hashes. Engine 1 log payloads in the wild carry the real
`contract`, `topics` and `data` fields this fixture mirrors.

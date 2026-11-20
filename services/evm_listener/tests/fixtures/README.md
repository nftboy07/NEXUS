# Test fixtures

Provenance: **synthetic**. The block hashes, transaction hashes, topics, and
log data in these files were generated locally with SHA-256 (`h("seed")`) for
determinism. They have the same *shape* as real Ethereum JSON-RPC objects but
do **not** correspond to any real on-chain data and must never be presented as
real transaction evidence.

- `blocks_chain_a.json` — canonical chain A, blocks 100–106.
- `blocks_chain_b_fork.json` — fork chain B: shares blocks 100–102 with A, then
  diverges at block 103 (blocks 103–106 have B-side hashes and linked parents).
- `logs_chain_a.json` — logs on orphaned A-side blocks 103–104.
- `logs_chain_b_fork.json` — canonical replacement logs on B-side blocks 103–106.

Used by `reorg.test.ts` (fork resolution), `backfill.test.ts` (gap fills),
`dedup.test.ts` (redelivery), and `normalize.test.ts` (schema shape).

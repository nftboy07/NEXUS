// Dedup-key builder/parser. Log identity:
//   chain_id:block_hash:tx_hash:log_index   (docs/database.md, event.schema.json)
// Block identity:
//   chain_id:block_hash

export function buildLogDedupKey(
  chainId: number,
  blockHash: string,
  txHash: string,
  logIndex: number
): string {
  return `${chainId}:${blockHash}:${txHash}:${logIndex}`;
}

export function buildBlockDedupKey(chainId: number, blockHash: string): string {
  return `${chainId}:${blockHash}`;
}

export type ParsedDedupKey =
  | { kind: "log"; chainId: number; blockHash: string; txHash: string; logIndex: number }
  | { kind: "block"; chainId: number; blockHash: string };

export function parseDedupKey(key: string): ParsedDedupKey {
  const parts = key.split(":");
  if (parts.length === 4) {
    const [chainId, blockHash, txHash, logIndex] = parts;
    return {
      kind: "log",
      chainId: Number(chainId),
      blockHash,
      txHash,
      logIndex: Number(logIndex),
    };
  }
  if (parts.length === 2) {
    const [chainId, blockHash] = parts;
    return { kind: "block", chainId: Number(chainId), blockHash };
  }
  throw new Error(`Invalid dedup key: ${key}`);
}

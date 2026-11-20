// Raw viem log/block -> NexusNormalizedEvent (event.schema.json contract).

import { buildBlockDedupKey, buildLogDedupKey } from "@nexus/shared-utils";
import type { NexusNormalizedEvent } from "@nexus/event-schemas";
import type { SourceBlock, SourceLog } from "./rpc.js";

export function normalizeLog(log: SourceLog, chainId: number): NexusNormalizedEvent {
  return {
    chain_id: chainId,
    kind: "log",
    dedup_key: buildLogDedupKey(chainId, log.blockHash, log.transactionHash, log.logIndex),
    block_number: Number(log.blockNumber),
    block_hash: log.blockHash,
    tx_hash: log.transactionHash,
    log_index: log.logIndex,
    payload: {
      contract: log.address,
      topics: log.topics,
      data: log.data,
      transaction_index: log.transactionIndex ?? null,
      removed: log.removed ?? false,
    },
  };
}

export function normalizeBlock(block: SourceBlock, chainId: number): NexusNormalizedEvent {
  return {
    chain_id: chainId,
    kind: "block",
    dedup_key: buildBlockDedupKey(chainId, block.hash),
    block_number: Number(block.number),
    block_hash: block.hash,
    tx_hash: null,
    log_index: null,
    payload: {
      parent_hash: block.parentHash,
      timestamp: Number(block.timestamp),
    },
  };
}

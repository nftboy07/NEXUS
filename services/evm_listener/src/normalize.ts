// Raw viem log/block -> NexusNormalizedEvent (event.schema.json contract).

import { buildBlockDedupKey, buildLogDedupKey } from "@nexus/shared-utils";
import type { NexusNormalizedEvent } from "@nexus/event-schemas";
import type { SourceBlock, SourceLog } from "./rpc.js";

// keccak256("Transfer(address,address,uint256)")
const ERC20_TRANSFER_TOPIC0 = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function decodeTransfer(log: SourceLog): { from: string; to: string; value: string } | null {
  if (log.topics.length !== 3 || log.topics[0].toLowerCase() !== ERC20_TRANSFER_TOPIC0) return null;
  return {
    from: "0x" + log.topics[1].slice(-40),
    to: "0x" + log.topics[2].slice(-40),
    value: BigInt(log.data).toString(),
  };
}

export function normalizeLog(log: SourceLog, chainId: number): NexusNormalizedEvent {
  const transfer = decodeTransfer(log);
  if (transfer) {
    return {
      chain_id: chainId,
      kind: "transfer",
      dedup_key: buildLogDedupKey(chainId, log.blockHash, log.transactionHash, log.logIndex),
      block_number: Number(log.blockNumber),
      block_hash: log.blockHash,
      tx_hash: log.transactionHash,
      log_index: log.logIndex,
      payload: {
        token: log.address,
        from: transfer.from,
        to: transfer.to,
        value: transfer.value,
        topics: log.topics,
        data: log.data,
        transaction_index: log.transactionIndex ?? null,
        removed: log.removed ?? false,
      },
    };
  }
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

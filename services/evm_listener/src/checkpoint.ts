// Per-chain checkpoints: last processed block + log cursor.
// A checkpoint advances only after the block's events are stored AND published.

import type { Checkpoint, EventStore } from "./store.js";

export function checkpointCursor(blockNumber: bigint, logIndex: number): string {
  return `${blockNumber}:${logIndex}`;
}

export async function readCheckpoint(store: EventStore, chainId: number): Promise<Checkpoint> {
  return (await store.getCheckpoint(chainId)) ?? { chainId, lastBlock: 0n, lastLogCursor: null };
}

export async function advanceCheckpoint(
  store: EventStore,
  chainId: number,
  lastBlock: bigint,
  lastLogCursor: string | null
): Promise<void> {
  const current = await readCheckpoint(store, chainId);
  if (lastBlock < current.lastBlock) return; // never move backwards implicitly
  await store.setCheckpoint(chainId, lastBlock, lastLogCursor);
}

/** Rewind used by reorg handling: force the checkpoint back to a canonical ancestor. */
export async function rewindCheckpoint(
  store: EventStore,
  chainId: number,
  lastBlock: bigint,
  lastLogCursor: string | null = null
): Promise<void> {
  await store.setCheckpoint(chainId, lastBlock, lastLogCursor);
}

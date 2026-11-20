// Pending-tx lifecycle state machine (BLUEPRINT §4):
//   DETECTED -> PENDING -> INCLUDED -> CONFIRMED
//                        -> REPLACED | DROPPED | REORGED
// Every transition is persisted; transitions are idempotent — replaying the
// same checkpoint/head produces no duplicate state changes or events.
// A pending tx is an early signal from one node's mempool, never a fact.

import type { Logger } from "@nexus/shared-utils";
import type { PendingRow, PendingStatus, PendingStore } from "./store.js";

export interface LifecycleEvent {
  chainId: number;
  hash: string;
  from: PendingStatus | null;
  to: PendingStatus;
  block: bigint | null;
  replacedBy?: string | null;
}

export type LifecycleEmitter = (e: LifecycleEvent) => Promise<void>;

const ALLOWED: Record<PendingStatus, PendingStatus[]> = {
  DETECTED: ["PENDING", "INCLUDED", "REPLACED", "DROPPED"],
  PENDING: ["INCLUDED", "REPLACED", "DROPPED"],
  INCLUDED: ["CONFIRMED", "REORGED"],
  CONFIRMED: ["REORGED"],
  REPLACED: [],
  DROPPED: [],
  REORGED: [],
};

export async function transition(
  store: PendingStore,
  emit: LifecycleEmitter,
  row: Pick<PendingRow, "chainId" | "hash" | "status">,
  to: PendingStatus,
  fields: Partial<PendingRow> & { block?: bigint | null } = {},
): Promise<boolean> {
  if (!ALLOWED[row.status].includes(to)) return false; // idempotent / terminal
  await store.transition(row.chainId, row.hash, to, fields);
  await emit({
    chainId: row.chainId, hash: row.hash, from: row.status, to,
    block: fields.block ?? fields.includedBlock ?? null,
    replacedBy: fields.replacedBy ?? null,
  });
  return true;
}

/**
 * Advance all open pending rows on a chain to the head implied by Engine 1's
 * checkpoint (canonical confirmed data only — never mempool guesses).
 */
export async function resolveCheckpoint(
  store: PendingStore,
  emit: LifecycleEmitter,
  chainId: number,
  confirmations: number,
  dropAfterBlocks: number,
  log: Logger,
): Promise<number> {
  const head = await store.checkpoint(chainId);
  if (head === null) return 0;
  let moved = 0;

  // INCLUDED -> CONFIRMED at confirmation depth.
  for (const row of await store.pendingByStatus(chainId, ["INCLUDED"])) {
    if (row.includedBlock !== null && head - row.includedBlock >= BigInt(confirmations)) {
      if (await transition(store, emit, row, "CONFIRMED", { block: head })) moved++;
    }
  }

  // INCLUDED/CONFIRMED -> REORGED when the including block is non-canonical.
  for (const row of await store.pendingByStatus(chainId, ["INCLUDED", "CONFIRMED"])) {
    const inc = await store.getIncluded(chainId, row.hash);
    if (inc?.blockHash && !(await store.isCanonicalBlock(chainId, inc.blockNumber ?? 0n, inc.blockHash))) {
      if (await transition(store, emit, row, "REORGED", { block: head })) moved++;
    }
  }

  // DETECTED/PENDING -> INCLUDED / REPLACED / DROPPED.
  for (const row of await store.pendingByStatus(chainId, ["DETECTED", "PENDING"])) {
    const inc = await store.getIncluded(chainId, row.hash);
    if (inc?.blockNumber != null) {
      if (await transition(store, emit, row, "INCLUDED", { includedBlock: inc.blockNumber })) moved++;
      continue;
    }
    if (row.sender && row.nonce !== null) {
      const rep = await store.findReplacement(chainId, row.sender, row.nonce, row.hash);
      if (rep) {
        if (await transition(store, emit, row, "REPLACED", { replacedBy: rep.hash, includedBlock: rep.blockNumber })) moved++;
        continue;
      }
    }
    if (row.firstSeenBlock !== null && head - row.firstSeenBlock > BigInt(dropAfterBlocks)) {
      if (await transition(store, emit, row, "DROPPED", { block: head })) moved++;
    }
  }
  log.debug("checkpoint resolution", { chain_id: chainId, head: head.toString(), transitions: moved });
  return moved;
}

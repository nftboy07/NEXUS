// Pending-tx lifecycle state machine (BLUEPRINT §4):
//   DETECTED -> PENDING -> INCLUDED -> CONFIRMED
//                        -> REPLACED | DROPPED | REORGED
// Every transition is persisted; transitions are idempotent — replaying the
// same checkpoint/head produces no duplicate state changes or events.
// A pending tx is an early signal from one node's mempool, never a fact.

import type { Logger } from "@nexus/shared-utils";
import type { InclusionProbe } from "./subscription.js";
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
  probe?: InclusionProbe,
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
    const incHash = row.includedBlockHash ?? inc?.blockHash ?? null;
    const incNum = row.includedBlock ?? inc?.blockNumber ?? null;
    if (incHash && !(await store.isCanonicalBlock(chainId, incNum ?? 0n, incHash))) {
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
    // Engine 1 only stores log-emitting txs; receipts are the fallback
    // proof of inclusion for approvals/deployments/plain sends/failed txs.
    if (probe && row.firstSeenBlock !== null && head - row.firstSeenBlock >= 2n) {
      const receipt = await probe.getReceipt(chainId, row.hash);
      if (receipt) {
        if (await transition(store, emit, row, "INCLUDED", {
          includedBlock: receipt.blockNumber,
          includedBlockHash: receipt.blockHash,
        })) moved++;
        continue;
      }
    }
    if (row.firstSeenBlock !== null && head - row.firstSeenBlock > BigInt(dropAfterBlocks)) {
      // Drop window passed: a consumed account nonce means an unknown tx
      // replaced this one (replacement hash unknowable -> replaced_by null).
      let consumed = false;
      if (probe && row.sender && row.nonce !== null) {
        const nonce = await probe.getNonce(chainId, row.sender);
        consumed = nonce !== null && nonce > row.nonce;
      }
      if (consumed) {
        log.info("nonce consumed by unknown tx; marking replaced", { hash: row.hash });
        if (await transition(store, emit, row, "REPLACED", { replacedBy: null })) moved++;
      } else {
        if (await transition(store, emit, row, "DROPPED", { block: head })) moved++;
      }
    }
  }
  log.debug("checkpoint resolution", { chain_id: chainId, head: head.toString(), transitions: moved });
  return moved;
}

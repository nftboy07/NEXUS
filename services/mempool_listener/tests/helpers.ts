// Test fakes for Engine 2. Synthetic lifecycle data — labeled, not recorded.

import type { IncludedTx, PendingRow, PendingStatus, PendingStore } from "../src/store.js";

export class FakePendingStore implements PendingStore {
  rows = new Map<string, PendingRow>();
  included = new Map<string, IncludedTx>();          // transactions table (canonical)
  checkpointBlock: bigint | null = null;             // checkpoints table
  canonical = new Set<string>();                     // blocks table hashes
  health: Array<{ provider: string; chainId: number; errors: number }> = [];

  key(chainId: number, hash: string) { return `${chainId}:${hash}`; }

  async upsertPending(r: PendingRow): Promise<void> {
    const k = this.key(r.chainId, r.hash);
    this.rows.set(k, { ...(this.rows.get(k) ?? r), ...r });
  }

  async transition(chainId: number, hash: string, status: PendingStatus, f: Partial<PendingRow> = {}): Promise<void> {
    const r = this.rows.get(this.key(chainId, hash));
    if (!r) throw new Error(`unknown pending tx ${hash}`);
    r.status = status;
    if (f.includedBlock !== undefined) r.includedBlock = f.includedBlock;
    if (f.replacedBy !== undefined) r.replacedBy = f.replacedBy;
    if (f.sender !== undefined) r.sender = f.sender;
    if (f.nonce !== undefined) r.nonce = f.nonce;
  }

  async pendingByStatus(chainId: number, statuses: PendingStatus[]): Promise<PendingRow[]> {
    return [...this.rows.values()].filter((r) => r.chainId === chainId && statuses.includes(r.status));
  }

  async setWatchlistMatch(chainId: number, hash: string, match: string): Promise<void> {
    const r = this.rows.get(this.key(chainId, hash));
    if (r) r.watchlistMatch = match;
  }

  async getIncluded(chainId: number, hash: string): Promise<IncludedTx | null> {
    return this.included.get(this.key(chainId, hash)) ?? null;
  }

  async findReplacement(chainId: number, sender: string, nonce: bigint, excludeHash: string): Promise<IncludedTx | null> {
    for (const [k, t] of this.included) {
      if (k.startsWith(`${chainId}:`) && t.sender === sender && t.nonce === nonce && t.hash !== excludeHash) return t;
    }
    return null;
  }

  async checkpoint(): Promise<bigint | null> { return this.checkpointBlock; }

  async isCanonicalBlock(_chainId: number, _n: bigint, hash: string): Promise<boolean> {
    return this.canonical.has(hash);
  }

  async recordProviderHealth(row: { provider: string; chainId: number; latencyMs: number; errors: number }): Promise<void> {
    this.health.push(row);
  }

  async close(): Promise<void> {}
}

export function pendingRow(over: Partial<PendingRow> = {}): PendingRow {
  return {
    chainId: 1, hash: "0xhash", sender: "0xsender", nonce: 5n, recipient: "0xto",
    value: "0", method: null, decoded: null, status: "PENDING",
    firstSeenBlock: 100n, includedBlock: null, replacedBy: null, ...over,
  };
}

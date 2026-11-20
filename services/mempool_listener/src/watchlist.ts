// Watchlist matching: pending tx sender/recipient/decoded token addresses
// against the watchlists table (wallets + contracts). Matches are flagged on
// the lifecycle record and the emitted pending_tx event payload.

import type { Pool, PoolClient } from "pg";
import type { DecodedTx } from "./decoder.js";

export interface WatchlistSource {
  entries(): Promise<{ kind: string; value: string }[]>;
}

export class PgWatchlists implements WatchlistSource {
  constructor(private pool: Pool | PoolClient) {}
  async entries(): Promise<{ kind: string; value: string }[]> {
    const res = await this.pool.query(`SELECT kind, value FROM watchlists`);
    return res.rows;
  }
}

export class WatchlistMatcher {
  private wallets = new Set<string>();
  private contracts = new Set<string>();

  constructor(private source: WatchlistSource) {}

  async refresh(): Promise<void> {
    this.wallets.clear();
    this.contracts.clear();
    for (const e of await this.source.entries()) {
      const v = e.value.toLowerCase();
      if (e.kind === "wallet") this.wallets.add(v);
      else if (e.kind === "contract") this.contracts.add(v);
    }
  }

  /** First matching rule, or null. */
  match(tx: { from?: string | null; to: string | null }, decoded: DecodedTx): string | null {
    if (tx.from && this.wallets.has(tx.from.toLowerCase())) return "sender";
    if (tx.to && this.wallets.has(tx.to.toLowerCase())) return "recipient";
    if (tx.to && this.contracts.has(tx.to.toLowerCase())) return "contract";
    if (decoded.tokens.some((t) => this.contracts.has(t))) return "decoded_token";
    return null;
  }
}

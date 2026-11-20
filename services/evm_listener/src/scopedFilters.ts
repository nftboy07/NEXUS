// Scoped log filters (LOG_FILTER_MODE=scoped, default): instead of
// subscribing to unscoped ERC-20 Transfer + DEX events across every
// contract, the listener scopes subscriptions to
//   (1) Transfer on the token allowlist (packages/chain_config/tokens.json);
//   (2) Transfer where topic1 (from) or topic2 (to) is a watchlist wallet
//       (watchlists table, kind 'wallet', padded to 32-byte topics);
//   (3) DEX Mint/Burn/Swap/Sync on factory-known addresses: dex factories +
//       pinned pools (dexes.json) + every pool in the pools table.
// Factory PoolCreated subscriptions are unchanged — they carry their own
// contract addresses.
// Address arrays are chunked at MAX_FILTER_ADDRESSES (default 10 — publicnode's eth_getLogs cap) per
// filter for both eth_getLogs and WS subscriptions.

import type { ParsedLogFilter } from "./subscriptions.js";

export interface TokenEntry {
  chain_id: number;
  symbol: string;
  address: string;
  decimals: number;
  source: string;
}

export interface PinnedPool {
  address: string;
  pair: string;
  derivation: string;
}

export interface DexEntry {
  chain_id: number;
  name: string;
  factory: string;
  pinned_pools?: PinnedPool[];
}

export interface ScopeInputs {
  chainId: number;
  tokens: TokenEntry[];        // already filtered to this chain
  watchWallets: string[];      // watchlists kind='wallet' addresses
  pools: string[];             // pools-table addresses for this chain
  dexes: DexEntry[];           // already filtered to this chain
  maxAddresses: number;
}

const TRANSFER_NAME = "erc20_transfer";
const DEX_PREFIX = "dex_";
const pad32 = (a: string) => `0x${a.toLowerCase().replace("0x", "").padStart(64, "0")}`;

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const uniq = (xs: string[]) => [...new Set(xs.map((x) => x.toLowerCase()))];

export function buildScopedFilters(base: ParsedLogFilter[], input: ScopeInputs): ParsedLogFilter[] {
  const out: ParsedLogFilter[] = [];
  const transfer = base.find((f) => f.name === TRANSFER_NAME);
  const sig = transfer?.topics[0] ?? null;

  for (const f of base) {
    if (f.name === TRANSFER_NAME) {
      // (1) allowlisted token contracts
      const addrs = uniq(input.tokens.map((t) => t.address));
      chunks(addrs, input.maxAddresses).forEach((chunk, i) => {
        out.push({ ...f, name: `${TRANSFER_NAME}:tokens:${i}`, address: chunk });
      });
      // (2) watchlist wallets as topic1 (from) and topic2 (to), any token
      const wallets = uniq(input.watchWallets);
      chunks(wallets, input.maxAddresses).forEach((chunk, i) => {
        const padded = chunk.map(pad32);
        out.push({ ...f, name: `${TRANSFER_NAME}:watch_from:${i}`, address: undefined,
                   topics: [sig!, padded], args: { from: chunk } });
        out.push({ ...f, name: `${TRANSFER_NAME}:watch_to:${i}`, address: undefined,
                   topics: [sig!, null, padded], args: { to: chunk } });
      });
    } else if (f.name.startsWith(DEX_PREFIX)) {
      // (3) DEX events scoped to known addresses
      const addrs = uniq([
        ...input.dexes.map((d) => d.factory),
        ...input.dexes.flatMap((d) => (d.pinned_pools ?? []).map((p) => p.address)),
        ...input.pools,
      ]);
      chunks(addrs, input.maxAddresses).forEach((chunk, i) => {
        out.push({ ...f, name: `${f.name}:${i}`, address: chunk });
      });
    } else {
      out.push(f); // factory PoolCreated etc. — unchanged
    }
  }
  return out;
}

/** Stable identity for change detection on refresh. */
export function filterFingerprint(filters: ParsedLogFilter[]): string {
  return JSON.stringify(filters.map((f) => ({ name: f.name, address: f.address, topics: f.topics })));
}

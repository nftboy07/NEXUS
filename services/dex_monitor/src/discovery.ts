// Lazy pool discovery: a Swap/Sync/Mint/Burn log from an unregistered
// address may still be a pool created before this listener started. Probe
// the contract over HTTP RPC (factory/token0/token1, + fee for V3 / stable
// for Aerodrome) under the shared bounded retry; a factory() in the
// known-factory map registers the pool. Non-pool addresses are
// negative-cached in a bounded LRU so random contracts aren't re-queried.

import { parseAbiItem, decodeFunctionResult, encodeFunctionData, type AbiFunction } from "viem";
import { retry } from "@nexus/shared-utils";
import type { FactoryMap } from "./processor.js";

const FACTORY = parseAbiItem("function factory() view returns (address)") as AbiFunction;
const TOKEN0 = parseAbiItem("function token0() view returns (address)") as AbiFunction;
const TOKEN1 = parseAbiItem("function token1() view returns (address)") as AbiFunction;
const FEE = parseAbiItem("function fee() view returns (uint24)") as AbiFunction;
const STABLE = parseAbiItem("function stable() view returns (bool)") as AbiFunction;

/** eth_call seam — production wires a viem publicClient per chain; tests fake it. */
export type RpcCaller = (chainId: number, to: string, data: `0x${string}`) => Promise<`0x${string}`>;

export interface DiscoveredPool {
  dex: string;
  dexType: "v2" | "v3" | "aerodrome";
  token0: string;
  token1: string;
  feeTier: number | null;
  stable: boolean | null;
  discovery: "lazy";
}

const enc = (fn: AbiFunction) => encodeFunctionData({ abi: [fn], functionName: fn.name }) as `0x${string}`;

export class LazyPoolDiscovery {
  /** Bounded negative cache: address key -> true means "known not a pool". */
  private notPool = new Map<string, true>();

  constructor(
    private call: RpcCaller,
    private factoriesPerChain: Map<number, FactoryMap>,
    private maxNegative = 10_000,
    private retryOpts = { maxAttempts: 3, baseMs: 200, maxMs: 2_000 }
  ) {}

  private async call0(chainId: number, to: string, fn: AbiFunction): Promise<string | null> {
    try {
      const data = await retry(() => this.call(chainId, to, enc(fn)), this.retryOpts);
      if (!data || data === "0x") return null;
      return String(
        decodeFunctionResult({ abi: [fn], functionName: fn.name, data })
      ).toLowerCase();
    } catch {
      return null;
    }
  }

  /** Null when the address is not a pool of a known factory (or unverifiable). */
  async discover(chainId: number, address: string): Promise<DiscoveredPool | null> {
    const addr = address.toLowerCase();
    const cacheKey = `${chainId}:${addr}`;
    if (this.notPool.has(cacheKey)) return null;
    const factories = this.factoriesPerChain.get(chainId);
    if (!factories || factories.size === 0) return null;

    const factoryAddr = await this.call0(chainId, addr, FACTORY);
    const meta = factoryAddr ? factories.get(factoryAddr) : undefined;
    if (!factoryAddr || !meta) {
      this.negative(cacheKey);
      return null;
    }

    const [token0, token1] = await Promise.all([
      this.call0(chainId, addr, TOKEN0),
      this.call0(chainId, addr, TOKEN1),
    ]);
    if (!token0 || !token1) {
      this.negative(cacheKey);
      return null;
    }
    let feeTier: number | null = null;
    let stable: boolean | null = null;
    if (meta.type === "v3") {
      const fee = await this.call0(chainId, addr, FEE);
      feeTier = fee === null ? null : Number(fee);
    } else if (meta.type === "aerodrome") {
      const s = await this.call0(chainId, addr, STABLE);
      stable = s === "true";
    }
    return { dex: meta.name, dexType: meta.type, token0, token1, feeTier, stable, discovery: "lazy" };
  }

  private negative(key: string): void {
    if (this.notPool.size >= this.maxNegative) {
      this.notPool.delete(this.notPool.keys().next().value!); // evict oldest
    }
    this.notPool.set(key, true);
  }
}

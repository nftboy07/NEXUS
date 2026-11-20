// Engine 2 config: chains.json + env. Mempool feeds only run on chains with
// a configured WSS endpoint AND a provider that passes the pending-sub probe.

import { readFileSync } from "node:fs";

const CHAINS_URL = new URL("../../../packages/chain_config/chains.json", import.meta.url);

export interface MempoolChainConfig {
  id: number;
  name: string;
  confirmations: number;
  wssUrl: string;
  httpUrl: string;
}

export interface MempoolConfig {
  chains: MempoolChainConfig[];
  redisUrl: string;
  databaseUrl: string;
  /** Blocks without inclusion/replacement before a pending tx is DROPPED. */
  dropAfterBlocks: number;
  /** Max concurrently in-flight eth_getTransactionByHash fetches per chain. */
  maxInflight: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MempoolConfig {
  const { chains } = JSON.parse(readFileSync(CHAINS_URL, "utf8")) as {
    chains: Array<{
      id: number; name: string; confirmations?: number;
      wss_env?: string; http_env?: string; planned?: boolean;
    }>;
  };
  const live = chains.filter((c) => !c.planned && c.wss_env && env[c.wss_env] && c.http_env && env[c.http_env!]);
  return {
    chains: live.map((c) => ({
      id: c.id,
      name: c.name,
      confirmations: c.confirmations ?? 12,
      wssUrl: env[c.wss_env!]!,
      httpUrl: env[c.http_env!]!,
    })),
    redisUrl: env.REDIS_URL ?? "",
    databaseUrl: env.DATABASE_URL ?? "",
    dropAfterBlocks: Number(env.MEMPOOL_DROP_AFTER_BLOCKS ?? 50),
    maxInflight: Number(env.MEMPOOL_MAX_INFLIGHT ?? 200),
  };
}

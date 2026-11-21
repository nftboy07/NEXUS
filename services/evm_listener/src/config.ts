// Chain config of record: packages/chain_config/chains.json.
// Each enabled chain resolves its primary endpoint from `wss_env` / `http_env`
// env vars; an optional secondary provider comes from `<ENV_NAME>_SECONDARY`.
// Chains with "planned": true are skipped. Missing primary env fails loudly.

import { readFileSync } from "node:fs";

export interface RawChainEntry {
  id: number;
  name: string;
  confirmations?: number;
  wss_env?: string;
  http_env?: string;
  planned?: boolean;
  start_block?: number;
  explorer_url?: string;
}

export interface ChainConfig {
  id: number;
  name: string;
  confirmations: number;
  wssEnv: string;
  httpEnv: string;
  wssUrl: string;
  httpUrl: string;
  wssUrlSecondary?: string;
  httpUrlSecondary?: string;
  /** Optional per-chain cold-start block from chains.json (`start_block`). */
  startBlock?: bigint;
}

const CHAINS_JSON_URL = new URL("../../../packages/chain_config/chains.json", import.meta.url);

export function loadChainsFile(url: URL = CHAINS_JSON_URL): RawChainEntry[] {
  const parsed = JSON.parse(readFileSync(url, "utf8")) as { chains: RawChainEntry[] };
  return parsed.chains;
}

export function loadChainConfigs(
  env: NodeJS.ProcessEnv = process.env,
  chains: RawChainEntry[] = loadChainsFile()
): ChainConfig[] {
  const enabled = chains.filter((c) => !c.planned);
  const missing: string[] = [];
  const out: ChainConfig[] = [];

  for (const c of enabled) {
    if (!c.wss_env || !c.http_env) {
      missing.push(`${c.name}: chain entry lacks wss_env/http_env`);
      continue;
    }
    const wssUrl = env[c.wss_env];
    const httpUrl = env[c.http_env];
    if (!wssUrl) missing.push(`${c.name}: missing primary env ${c.wss_env}`);
    if (!httpUrl) missing.push(`${c.name}: missing primary env ${c.http_env}`);
    if (!wssUrl || !httpUrl) continue;

    out.push({
      id: c.id,
      name: c.name,
      confirmations: c.confirmations ?? 12,
      wssEnv: c.wss_env,
      httpEnv: c.http_env,
      wssUrl,
      httpUrl,
      wssUrlSecondary: env[`${c.wss_env}_SECONDARY`],
      httpUrlSecondary: env[`${c.http_env}_SECONDARY`],
      startBlock: c.start_block !== undefined ? BigInt(c.start_block) : undefined,
    });
  }

  if (missing.length > 0) {
    throw new Error(`Chain config errors:\n  ${missing.join("\n  ")}`);
  }
  return out;
}

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min = 1): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) throw new Error(`${name} must be a number >= ${min} (got "${raw}")`);
  return Math.floor(n);
}

/** Backfill throughput knobs. Defaults are sized for free public RPCs
 * (publicnode): 8 blocks in flight, <= 8 concurrent requests per chain. */
export function backfillOptionsFromEnv(env: NodeJS.ProcessEnv = process.env) {
  return {
    chunkSize: intEnv(env, "BACKFILL_CHUNK_SIZE", 2000),
    blockConcurrency: intEnv(env, "BACKFILL_BLOCK_CONCURRENCY", 8),
    rpcConcurrency: intEnv(env, "RPC_MAX_CONCURRENCY", 8),
  };
}

/** Tx enrichment knobs shared by backfill + live paths. */
export function ingestOptionsFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const mode = (env.TX_ENRICH_MODE ?? "auto").toLowerCase();
  if (mode !== "auto" && mode !== "tx" && mode !== "block") {
    throw new Error(`TX_ENRICH_MODE must be auto|tx|block (got "${env.TX_ENRICH_MODE}")`);
  }
  return {
    ingestTransactions: (env.INGEST_TRANSACTIONS ?? "true") !== "false",
    txFetchConcurrency: intEnv(env, "TX_FETCH_CONCURRENCY", 8),
    txEnrichMode: mode as "auto" | "tx" | "block",
    blockEnrichThreshold: intEnv(env, "BLOCK_ENRICH_THRESHOLD", 4),
  };
}

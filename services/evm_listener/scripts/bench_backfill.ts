// Backfill throughput benchmark against a live (free public) RPC + local
// Postgres/Redis. Replays a FIXED block range so before/after runs compare
// like for like. Usage (from services/evm_listener):
//   DATABASE_URL=postgresql://nexus:nexus@localhost:5432/nexus_bench \
//   REDIS_URL=redis://localhost:6379 \
//   npx tsx scripts/bench_backfill.ts --chain 8453 --blocks 300 --to 23000000
// Clears blocks/logs/transactions/checkpoints for --chain in DATABASE_URL
// first, so point it at a scratch database, never the live one.

import "dotenv/config";
import pg from "pg";
import { createClient } from "redis";
import { readFileSync } from "node:fs";
import { createPublicClient, http } from "viem";
import { createLogger } from "@nexus/shared-utils";
import { loadChainConfigs } from "../src/config.js";
import { viemChainSource, type ChainSource } from "../src/rpc.js";
import { loadLogFilters, parseLogFilters } from "../src/subscriptions.js";
import { buildScopedFilters, type DexEntry, type TokenEntry } from "../src/scopedFilters.js";
import { PgStore } from "../src/store.js";
import { RedisPublisher } from "../src/publisher.js";
import { backfillRange } from "../src/backfill.js";
import { backfillOptionsFromEnv, ingestOptionsFromEnv } from "../src/config.js";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

/** Count + time every RPC method the backfill path issues. */
function instrument(src: ChainSource) {
  const stats: Record<string, { calls: number; ms: number }> = {};
  const wrap = <K extends keyof ChainSource>(k: K): ChainSource[K] =>
    (async (...a: unknown[]) => {
      const t = performance.now();
      try {
        return await (src[k] as (...x: unknown[]) => Promise<unknown>)(...a);
      } finally {
        const s = (stats[k] ??= { calls: 0, ms: 0 });
        s.calls++;
        s.ms += performance.now() - t;
      }
    }) as ChainSource[K];
  const out = Object.fromEntries(Object.keys(src).map((k) => [k, wrap(k as keyof ChainSource)])) as unknown as ChainSource;
  return { source: out, stats };
}

async function main() {
  const chainId = Number(arg("chain", "8453"));
  const nBlocks = BigInt(arg("blocks", "300")!);
  const chain = loadChainConfigs().find((c) => c.id === chainId);
  if (!chain) throw new Error(`chain ${chainId} not configured`);
  const client = createPublicClient({
    transport: http(chain.httpUrl, { retryCount: 1, timeout: Number(process.env.RPC_TIMEOUT_MS ?? 10_000) }),
  });
  const raw = viemChainSource(client as never);
  const to = arg("to") ? BigInt(arg("to")!) : (await raw.getBlockNumber()) - 20n;
  const from = to - nBlocks; // exclusive

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const store = new PgStore(pool);
  for (const t of ["blocks", "logs", "transactions", "checkpoints"]) {
    await pool.query(`DELETE FROM ${t} WHERE chain_id = $1`, [chainId]);
  }
  await store.setCheckpoint(chainId, from, null);
  const redis = createClient({ url: process.env.REDIS_URL });
  await redis.connect();
  await redis.del("nexus:bench");
  const publisher = new RedisPublisher(redis, "nexus:bench");

  const tokens = (JSON.parse(readFileSync(new URL("../../../packages/chain_config/tokens.json", import.meta.url), "utf8")) as { tokens: TokenEntry[] }).tokens;
  const dexes = (JSON.parse(readFileSync(new URL("../../../packages/chain_config/dexes.json", import.meta.url), "utf8")) as { dexes: DexEntry[] }).dexes;
  const filters = buildScopedFilters(parseLogFilters(loadLogFilters()), {
    chainId,
    tokens: tokens.filter((t) => t.chain_id === chainId),
    watchWallets: [],
    pools: [],
    dexes: dexes.filter((d) => d.chain_id === chainId),
    maxAddresses: Number(process.env.MAX_FILTER_ADDRESSES ?? 10),
  });

  const { source, stats } = instrument(raw);
  const log = createLogger("bench", { minLevel: (process.env.LOG_LEVEL as never) ?? "warn" });
  const opts = backfillOptionsFromEnv(process.env);
  const ingestOpts = ingestOptionsFromEnv(process.env);
  const t0 = performance.now();
  const res = await backfillRange(
    source,
    filters,
    { chainId, store, publisher, log, ...ingestOpts },
    to,
    opts
  );
  const secs = (performance.now() - t0) / 1000;
  const q = async (sql: string) => Number((await pool.query(sql, [chainId])).rows[0].n);
  const out = {
    chain_id: chainId,
    range: `${from + 1n}-${to}`,
    blocks: Number(nBlocks),
    seconds: Number(secs.toFixed(2)),
    blocks_per_sec: Number((Number(nBlocks) / secs).toFixed(2)),
    rows: {
      blocks: await q("SELECT COUNT(*) n FROM blocks WHERE chain_id=$1"),
      logs: await q("SELECT COUNT(*) n FROM logs WHERE chain_id=$1"),
      transactions: await q("SELECT COUNT(*) n FROM transactions WHERE chain_id=$1"),
      checkpoint: await q("SELECT last_block n FROM checkpoints WHERE chain_id=$1"),
      stream_events: Number(await redis.xLen("nexus:bench")),
    },
    logs_inserted: res.logsInserted,
    rpc: stats,
    opts: { ...opts, ...ingestOpts },
  };
  console.log(JSON.stringify(out, null, 1));
  await redis.quit();
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

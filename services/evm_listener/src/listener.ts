// NEXUS Engine 1 — multi-chain EVM listener (Crypto Relic).
// Thin orchestrator: one isolated ChainRunner per enabled chain, graceful
// shutdown on SIGTERM/SIGINT.

import "dotenv/config";
import pg from "pg";
import { createClient } from "redis";
import { createLogger } from "@nexus/shared-utils";
import { loadChainConfigs } from "./config.js";
import { createChainClients } from "./rpc.js";
import { readFileSync } from "node:fs";
import { loadLogFilters, parseLogFilters } from "./subscriptions.js";
import { buildScopedFilters, type DexEntry, type TokenEntry } from "./scopedFilters.js";
import { PgStore } from "./store.js";
import { RedisPublisher } from "./publisher.js";
import { runChains } from "./runner.js";

const log = createLogger("evm_listener");

async function main() {
  const chains = loadChainConfigs();
  if (chains.length === 0) {
    log.warn("no enabled chains configured — check .env");
    return;
  }
  const baseFilters = parseLogFilters(loadLogFilters());
  const filterMode = (process.env.LOG_FILTER_MODE ?? "scoped").toLowerCase();
  log.info("loaded log filters", { filters: baseFilters.map((f) => f.name), mode: filterMode });
  const tokens = (JSON.parse(readFileSync(
    new URL("../../../packages/chain_config/tokens.json", import.meta.url), "utf8")) as { tokens: TokenEntry[] }).tokens;
  const dexes = (JSON.parse(readFileSync(
    new URL("../../../packages/chain_config/dexes.json", import.meta.url), "utf8")) as { dexes: DexEntry[] }).dexes;
  const maxFilterAddresses = Number(process.env.MAX_FILTER_ADDRESSES ?? 10);
  const filterRefreshSeconds = Number(process.env.FILTER_REFRESH_SECONDS ?? 60);

  const databaseUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;
  if (!databaseUrl) throw new Error("Missing DATABASE_URL");
  if (!redisUrl) throw new Error("Missing REDIS_URL");

  const pool = new pg.Pool({ connectionString: databaseUrl });
  const store = new PgStore(pool);

  const redis = createClient({ url: redisUrl });
  await redis.connect();
  const publisher = new RedisPublisher(redis);

  let stopping = false;
  const runners = await runChains(
    chains.map((chain) => ({
      chain,
      filters: baseFilters,
      store,
      publisher,
      log,
      clients: createChainClients(chain),
      chunkSize: Number(process.env.BACKFILL_CHUNK_SIZE ?? 2000),
      startBackfillBlocks: Number(process.env.START_BACKFILL_BLOCKS ?? 50),
      ingestTransactions: (process.env.INGEST_TRANSACTIONS ?? "true") !== "false",
      txFetchConcurrency: Number(process.env.TX_FETCH_CONCURRENCY ?? 8),
      heartbeatTimeoutMs: Number(process.env.HEARTBEAT_TIMEOUT_MS ?? 60_000),
      filterRefresh: filterMode === "scoped"
        ? {
            intervalSeconds: filterRefreshSeconds,
            build: async () => buildScopedFilters(baseFilters, {
              chainId: chain.id,
              tokens: tokens.filter((t) => t.chain_id === chain.id),
              watchWallets: await store.watchlistWallets(),
              pools: await store.poolAddresses(chain.id),
              dexes: dexes.filter((d) => d.chain_id === chain.id),
              maxAddresses: maxFilterAddresses,
            }),
          }
        : undefined,
    })),
    (chain, err) => log.error("chain failed to start — continuing with others, will retry", { chain: chain.name, err: String(err) }),
    { retryDelayMs: Number(process.env.CHAIN_START_RETRY_MS ?? 15_000), isStopped: () => stopping }
  );

  if (runners.length === 0) {
    log.error("no chains started yet; retrying in background");
  }

  const shutdown = async (signal: string) => {
    log.info("shutdown requested", { signal });
    stopping = true;
    await Promise.allSettled(runners.map((r) => r.stop()));
    await publisher.close();
    await store.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  log.info("NEXUS evm_listener running", { chains: runners.map((r) => r.deps.chain.name) });
}

main().catch((err) => {
  log.error("fatal listener error", { err: String(err) });
  process.exitCode = 1;
});

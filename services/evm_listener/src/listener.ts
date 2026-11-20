// NEXUS Engine 1 — multi-chain EVM listener (Crypto Relic).
// Thin orchestrator: one isolated ChainRunner per enabled chain, graceful
// shutdown on SIGTERM/SIGINT.

import "dotenv/config";
import pg from "pg";
import { createClient } from "redis";
import { createLogger } from "@nexus/shared-utils";
import { loadChainConfigs } from "./config.js";
import { createChainClients } from "./rpc.js";
import { loadLogFilters, parseLogFilters } from "./subscriptions.js";
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
  const filters = parseLogFilters(loadLogFilters());
  log.info("loaded log filters", { filters: filters.map((f) => f.name) });

  const databaseUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;
  if (!databaseUrl) throw new Error("Missing DATABASE_URL");
  if (!redisUrl) throw new Error("Missing REDIS_URL");

  const pool = new pg.Pool({ connectionString: databaseUrl });
  const store = new PgStore(pool);

  const redis = createClient({ url: redisUrl });
  await redis.connect();
  const publisher = new RedisPublisher(redis);

  const runners = await runChains(
    chains.map((chain) => ({
      chain,
      filters,
      store,
      publisher,
      log,
      clients: createChainClients(chain),
      chunkSize: Number(process.env.BACKFILL_CHUNK_SIZE ?? 2000),
      startBackfillBlocks: Number(process.env.START_BACKFILL_BLOCKS ?? 50),
      heartbeatTimeoutMs: Number(process.env.HEARTBEAT_TIMEOUT_MS ?? 60_000),
    })),
    (chain, err) => log.error("chain failed to start — continuing with others", { chain: chain.name, err: String(err) })
  );

  if (runners.length === 0) {
    log.error("no chains started; exiting");
    process.exitCode = 1;
  }

  const shutdown = async (signal: string) => {
    log.info("shutdown requested", { signal });
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

// NEXUS Engine 4 — DEX & liquidity monitor (Crypto Relic).
// Redis consumer-group worker on nexus:events -> DexProcessor.
// Restarts resume at the group cursor without reprocessing.

import "dotenv/config";
import pg from "pg";
import { createClient } from "redis";
import { createLogger } from "@nexus/shared-utils";
import type { NexusNormalizedEvent } from "@nexus/event-schemas";
import { PgDexStore } from "./store.js";
import { PoolRegistry } from "./pools.js";
import { DexProcessor, buildFactoryMap, loadDexes } from "./processor.js";
import { DbStreamAlertSink } from "./alerts.js";
import { LazyPoolDiscovery, type RpcCaller } from "./discovery.js";
import { createPublicClient, http } from "viem";
import { readFileSync } from "node:fs";

const CHAINS_URL = new URL("../../../packages/chain_config/chains.json", import.meta.url);

function loadChainHttpEnv(): Map<number, string> {
  const { chains } = JSON.parse(readFileSync(CHAINS_URL, "utf8")) as {
    chains: Array<{ id: number; http_env?: string; planned?: boolean }>;
  };
  const m = new Map<number, string>();
  for (const c of chains) {
    if (c.planned || !c.http_env) continue;
    m.set(c.id, c.http_env);
  }
  return m;
}

const log = createLogger("dex_monitor");
const GROUP = "dex_monitor";
const CONSUMER = `worker-${process.pid}`;
const STREAM = "nexus:events";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;
  if (!databaseUrl) throw new Error("Missing DATABASE_URL");
  if (!redisUrl) throw new Error("Missing REDIS_URL");

  const removalThresholdPct = Number(process.env.LIQ_REMOVAL_ALERT_PCT ?? 20);
  // Process events for every live chain — pool/factory matching is chain-scoped.
  const chainIds = (process.env.DEX_CHAIN_IDS ?? "1,8453").split(",").map((s) => Number(s.trim()));

  const pool = new pg.Pool({ connectionString: databaseUrl });
  const store = new PgDexStore(pool);
  const redis = createClient({ url: redisUrl });
  await redis.connect();

  await redis.xGroupCreate(STREAM, GROUP, "$", { MKSTREAM: true }).catch((err) => {
    if (!String(err).includes("BUSYGROUP")) throw err;
  });

  const dexes = loadDexes();
  const registry = new PoolRegistry(store);
  const sink = new DbStreamAlertSink(store, (stream, fields) => redis.xAdd(stream, "*", fields));
  // The processor handles events chain-agnostically; pools are keyed
  // chain_id:address and factories are filtered per chain inside the handler.
  const allFactories = new Map<string, { name: string; type: "v2" | "v3" | "aerodrome"; chains: Set<number> }>();
  for (const id of chainIds) {
    for (const [addr, f] of buildFactoryMap(dexes, id)) {
      const e = allFactories.get(addr);
      if (e) e.chains.add(id);
      else allFactories.set(addr, { ...f, chains: new Set([id]) });
    }
  }
  // Lazy pool discovery: HTTP RPC probe per chain (chains.json http_env).
  const chainHttp = loadChainHttpEnv();
  const clients = new Map<number, ReturnType<typeof createPublicClient>>();
  const factoriesPerChain = new Map<number, ReturnType<typeof buildFactoryMap>>();
  for (const id of chainIds) {
    factoriesPerChain.set(id, buildFactoryMap(dexes, id));
    const envName = chainHttp.get(id);
    const url = envName ? process.env[envName] : undefined;
    if (url) clients.set(id, createPublicClient({ transport: http(url) }));
    else log.warn("no HTTP RPC configured; lazy discovery disabled for chain", { chain_id: id, env: envName });
  }
  const caller: RpcCaller = async (chainId, to, data) => {
    const client = clients.get(chainId);
    if (!client) throw new Error(`no RPC client for chain ${chainId}`);
    const res = await client.call({ to: to as `0x${string}`, data });
    return (res.data ?? "0x") as `0x${string}`;
  };
  const discovery = new LazyPoolDiscovery(caller, factoriesPerChain);

  const processor = new DexProcessor({
    store,
    registry,
    factories: new Map([...allFactories].map(([a, f]) => [a, { name: f.name, type: f.type }])),
    sink,
    removalThresholdPct,
    log,
    discovery,
  });

  let stopped = false;
  const shutdown = async (sig: string) => {
    log.info("shutdown requested", { signal: sig });
    stopped = true;
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  log.info("NEXUS dex_monitor consuming nexus:events", { group: GROUP, chains: chainIds });

  while (!stopped) {
    const res = await redis.xReadGroup(GROUP, CONSUMER, [{ key: STREAM, id: ">" }], {
      COUNT: 100,
      BLOCK: 2000,
    });
    if (!res) continue;
    for (const stream of res) {
      for (const msg of stream.messages) {
        try {
          const raw = msg.message.event;
          if (!raw) {
            await redis.xAck(STREAM, GROUP, msg.id);
            continue;
          }
          const ev = JSON.parse(raw) as NexusNormalizedEvent;
          await processor.handleEvent(ev);
          await redis.xAck(STREAM, GROUP, msg.id);
        } catch (err) {
          // Leave unacked: redelivery is safe (all writes idempotent).
          log.error("event processing failed", { msg_id: msg.id, err: String(err) });
        }
      }
    }
  }

  await redis.quit();
  await store.close();
}

main().catch((err) => {
  log.error("fatal dex_monitor error", { err: String(err) });
  process.exitCode = 1;
});

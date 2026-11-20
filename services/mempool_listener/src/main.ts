// NEXUS Engine 2 — mempool intelligence (Crypto Relic).
// Per-chain isolated workers: WS pending-hash subscription -> bounded fetch
// -> decode -> lifecycle persist + publish. Pending is a signal, not fact.

import "dotenv/config";
import pg from "pg";
import { createClient } from "redis";
import { createPublicClient, http, webSocket } from "viem";
import { createBackoff, createLogger } from "@nexus/shared-utils";
import { loadConfig, type MempoolChainConfig } from "./config.js";
import { PgPendingStore, type PendingRow } from "./store.js";
import { decodeTx } from "./decoder.js";
import { resolveCheckpoint } from "./lifecycle.js";
import { publishTransition, pendingTxEvent, RedisStreamWriter, EVENTS_STREAM } from "./publisher.js";
import { probePendingSupport, reportCapability } from "./capability.js";
import { FetchQueue, type TxFetcher } from "./subscription.js";
import { WatchlistMatcher, PgWatchlists } from "./watchlist.js";

const log = createLogger("mempool_listener");

async function runChain(
  chain: MempoolChainConfig,
  store: PgPendingStore,
  writer: RedisStreamWriter,
  matcher: WatchlistMatcher,
  dropAfter: number,
  maxInflight: number,
  stopped: () => boolean,
): Promise<void> {
  const ws = createPublicClient({ transport: webSocket(chain.wssUrl) });
  const httpClient = createPublicClient({ transport: http(chain.httpUrl) });
  const fetcher: TxFetcher = {
    getTransaction: async (hash) => {
      const tx = await httpClient.getTransaction({ hash: hash as `0x${string}` });
      return { hash: tx.hash, from: tx.from, to: tx.to, input: tx.input, value: tx.value, nonce: BigInt(tx.nonce) };
    },
  };
  const queue = new FetchQueue(fetcher, maxInflight, 50, log);
  const emit = (e: Parameters<typeof publishTransition>[1]) => publishTransition(writer, e);
  const backoff = createBackoff({ baseMs: 1_000, capMs: 30_000, maxAttempts: 10 });
  let attempt = 0;

  while (!stopped()) {
    let unwatch: (() => void) | undefined;
    try {
      const cap = await probePendingSupport(
        (onHash, onErr) => ws.watchPendingTransactions({ onTransactions: (hs) => hs.forEach(onHash), onError: onErr }),
        15_000,
      );
      reportCapability(cap.supported, cap.reason, chain.id, log);
      await store.recordProviderHealth({ provider: chain.name, chainId: chain.id, latencyMs: 0, errors: cap.supported ? 0 : 1 });
      if (!cap.supported) return; // feed disabled — never substitute polling

      attempt = 0;
      const tick = setInterval(() => {
        void resolveCheckpoint(store, emit, chain.id, chain.confirmations, dropAfter, log)
          .catch((e) => log.error("resolve failed", { err: String(e) }));
      }, 15_000);
      try {
        await new Promise<void>((resolve) => {
          unwatch = ws.watchPendingTransactions({
            onTransactions: (hashes) => {
              for (const hash of hashes) void handleHash(hash, chain, store, writer, matcher, queue, emit);
            },
            onError: (e) => { log.error("pending subscription error", { err: String(e) }); resolve(); },
          });
          const stopCheck = setInterval(() => {
            if (stopped()) { clearInterval(stopCheck); resolve(); }
          }, 500);
        });
      } finally {
        clearInterval(tick);
      }
    } catch (e) {
      log.error("chain worker error", { chain_id: chain.id, err: String(e) });
    } finally {
      try { unwatch?.(); } catch { /* ignore */ }
    }
    if (stopped()) break;
    await backoff.wait(attempt++);
  }
}

async function handleHash(
  hash: string,
  chain: MempoolChainConfig,
  store: PgPendingStore,
  writer: RedisStreamWriter,
  matcher: WatchlistMatcher,
  queue: FetchQueue,
  emit: (e: Parameters<typeof publishTransition>[1]) => Promise<unknown>,
): Promise<void> {
  try {
    const firstSeenBlock = await store.checkpoint(chain.id);
    const row: PendingRow = {
      chainId: chain.id, hash, sender: null, nonce: null, recipient: null,
      value: null, method: null, decoded: null, status: "DETECTED",
      firstSeenBlock, includedBlock: null, replacedBy: null,
    };
    await store.upsertPending(row);
    await emit({ chainId: chain.id, hash, from: null, to: "DETECTED", block: firstSeenBlock });

    const tx = await queue.fetch(hash);
    if (!tx) return;
    const decoded = decodeTx({ to: tx.to, input: tx.input, value: tx.value });
    const match = matcher.match(tx, decoded);
    await store.transition(chain.id, hash, "PENDING", {
      sender: tx.from, nonce: tx.nonce, recipient: tx.to,
      value: tx.value.toString(), method: decoded.method, decoded,
    } as Partial<PendingRow>);
    if (match) await store.setWatchlistMatch(chain.id, hash, match);
    const ev = pendingTxEvent(chain.id, {
      hash, sender: tx.from, to: tx.to, value: tx.value.toString(),
      method: decoded.method, decoded, status: "PENDING",
      firstSeenBlock, watchlistMatch: match,
    });
    await writer.xadd(EVENTS_STREAM, { event: JSON.stringify(ev) });
    await emit({ chainId: chain.id, hash, from: "DETECTED", to: "PENDING", block: firstSeenBlock });
  } catch (e) {
    log.error("pending hash failed", { hash, err: String(e) });
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.redisUrl) throw new Error("Missing REDIS_URL");
  if (!cfg.databaseUrl) throw new Error("Missing DATABASE_URL");
  if (cfg.chains.length === 0) {
    log.warn("no chains with configured WSS+HTTP endpoints; nothing to do");
    return;
  }
  const pool = new pg.Pool({ connectionString: cfg.databaseUrl });
  const store = new PgPendingStore(pool);
  const redis = createClient({ url: cfg.redisUrl });
  await redis.connect();
  const writer = new RedisStreamWriter(redis);
  const matcher = new WatchlistMatcher(new PgWatchlists(pool));
  await matcher.refresh();

  let stopped = false;
  process.on("SIGTERM", () => { stopped = true; });
  process.on("SIGINT", () => { stopped = true; });

  log.info("NEXUS mempool_listener started", { chains: cfg.chains.map((c) => c.id) });
  await Promise.allSettled(
    cfg.chains.map((c) => runChain(c, store, writer, matcher, cfg.dropAfterBlocks, cfg.maxInflight, () => stopped)),
  );
  await redis.quit();
  await pool.end();
  log.info("mempool_listener stopped");
}

void main();

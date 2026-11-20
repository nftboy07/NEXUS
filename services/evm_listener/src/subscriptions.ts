// watchBlocks + log watchers built from packages/chain_config/log_filters.json.
// Tracks last-message time per subscription for heartbeat staleness checks.

import { readFileSync } from "node:fs";
import { parseAbiItem, toEventSelector, type AbiEvent, type PublicClient } from "viem";
import type { SourceLog } from "./rpc.js";

const LOG_FILTERS_URL = new URL("../../../packages/chain_config/log_filters.json", import.meta.url);

export interface LogFilterEntry {
  name: string;
  kind: "event";
  event: string; // human-readable ABI signature, e.g. "event Transfer(...)"
  address?: string | string[];
}

export interface ParsedLogFilter {
  name: string;
  abiEvent: AbiEvent;
  address?: string | string[];
  topics: string[][];
}

export function loadLogFilters(url: URL = LOG_FILTERS_URL): LogFilterEntry[] {
  const parsed = JSON.parse(readFileSync(url, "utf8")) as { filters: LogFilterEntry[] };
  return parsed.filters;
}

export function parseLogFilters(entries: LogFilterEntry[]): ParsedLogFilter[] {
  return entries.map((e) => {
    const abiEvent = parseAbiItem(e.event) as AbiEvent;
    return { name: e.name, abiEvent, address: e.address, topics: eventTopics(abiEvent) };
  });
}

function eventTopics(event: AbiEvent): string[][] {
  // topic[0] = event signature hash; indexed args are wildcards for a plain subscription
  const sig = `${event.name}(${event.inputs.map((i) => i.type).join(",")})`;
  return [[signatureHash(sig)]];
}

function signatureHash(signature: string): string {
  return toEventSelector(signature);
}

export interface Subscription {
  name: string;
  startedAt: number;
  lastMessageAt: number;
  unwatch: () => void;
}

export interface SubscriptionCallbacks {
  onBlock: (block: { number: bigint; hash: string; parentHash: string; timestamp: bigint }) => void | Promise<void>;
  onLogs: (logs: SourceLog[]) => void | Promise<void>;
  onError: (err: unknown, subscription: string) => void;
}

/** Subscribe to new heads over WS. */
export function watchBlocks(ws: PublicClient, cb: SubscriptionCallbacks): Subscription {
  const sub: Subscription = { name: "blocks", startedAt: Date.now(), lastMessageAt: Date.now(), unwatch: () => {} };
  sub.unwatch = ws.watchBlocks({
    includeTransactions: false,
    onBlock: (b) => {
      sub.lastMessageAt = Date.now();
      void cb.onBlock({
        number: b.number,
        hash: b.hash ?? "",
        parentHash: b.parentHash ?? "",
        timestamp: b.timestamp,
      });
    },
    onError: (err) => cb.onError(err, "blocks"),
  });
  return sub;
}

/** Subscribe to logs for the configured filters over WS. */
export function watchLogs(ws: PublicClient, filters: ParsedLogFilter[], cb: SubscriptionCallbacks): Subscription[] {
  return filters.map((f) => {
    const sub: Subscription = { name: f.name, startedAt: Date.now(), lastMessageAt: Date.now(), unwatch: () => {} };
    sub.unwatch = ws.watchEvent({
      events: [f.abiEvent],
      address: f.address as never,
      onLogs: (logs) => {
        sub.lastMessageAt = Date.now();
        void cb.onLogs(
          logs.map((l) => ({
            address: l.address,
            blockHash: l.blockHash ?? "",
            blockNumber: l.blockNumber ?? 0n,
            transactionHash: l.transactionHash ?? "",
            logIndex: l.logIndex ?? 0,
            data: l.data,
            topics: l.topics as string[],
            transactionIndex: l.transactionIndex,
            removed: (l as { removed?: boolean }).removed ?? false,
          }))
        );
      },
      onError: (err) => cb.onError(err, f.name),
    });
    return sub;
  });
}

/** Milliseconds since a subscription last delivered anything. */
export function heartbeatStaleMs(sub: Subscription, now = Date.now()): number {
  return now - sub.lastMessageAt;
}

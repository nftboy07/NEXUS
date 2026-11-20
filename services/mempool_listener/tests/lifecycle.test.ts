// Lifecycle state-machine tests (synthetic block/checkpoint sequences).
// Drives every transition: included, replaced, dropped, reorged, confirmed —
// plus the acceptance replay: DETECTED→PENDING→INCLUDED→CONFIRMED.

import { describe, expect, it } from "vitest";
import { createLogger } from "@nexus/shared-utils";
import { resolveCheckpoint, transition, type LifecycleEvent } from "../src/lifecycle.js";
import { pendingTxEvent } from "../src/publisher.js";
import { FakePendingStore, pendingRow } from "./helpers.js";
import type { PendingStatus } from "../src/store.js";

const log = createLogger("test", { sink: () => {}, minLevel: "error" });

function collect() {
  const events: LifecycleEvent[] = [];
  return { events, emit: async (e: LifecycleEvent) => { events.push(e); } };
}

describe("pending lifecycle", () => {
  it("PENDING -> INCLUDED -> CONFIRMED at confirmation depth", async () => {
    const store = new FakePendingStore();
    const { events, emit } = collect();
    await store.upsertPending(pendingRow({ hash: "0x1" }));
    store.canonical.add("0xbh1");
    store.included.set("1:0x1", { hash: "0x1", sender: "0xsender", nonce: 5n, blockNumber: 110n, blockHash: "0xbh1" });

    store.checkpointBlock = 111n;
    await resolveCheckpoint(store, emit, 1, 12, 50, log);
    let row = (await store.pendingByStatus(1, ["INCLUDED"]))[0];
    expect(row.status).toBe("INCLUDED");
    expect(row.includedBlock).toBe(110n);

    store.checkpointBlock = 122n; // 122-110 = 12 = confirmations
    await resolveCheckpoint(store, emit, 1, 12, 50, log);
    row = (await store.pendingByStatus(1, ["CONFIRMED"]))[0];
    expect(row.status).toBe("CONFIRMED");
    expect(events.map((e) => e.to)).toEqual(["INCLUDED", "CONFIRMED"]);
  });

  it("PENDING -> REPLACED with replaced_by (same sender+nonce, other hash)", async () => {
    const store = new FakePendingStore();
    const { events, emit } = collect();
    await store.upsertPending(pendingRow({ hash: "0xold" }));
    store.included.set("1:0xnew", { hash: "0xnew", sender: "0xsender", nonce: 5n, blockNumber: 110n, blockHash: "0xbh" });
    store.canonical.add("0xbh");
    store.checkpointBlock = 111n;
    await resolveCheckpoint(store, emit, 1, 12, 50, log);
    const row = [...store.rows.values()][0];
    expect(row.status).toBe("REPLACED");
    expect(row.replacedBy).toBe("0xnew");
    expect(events[0].replacedBy).toBe("0xnew");
  });

  it("PENDING -> DROPPED after MEMPOOL_DROP_AFTER_BLOCKS", async () => {
    const store = new FakePendingStore();
    const { events, emit } = collect();
    await store.upsertPending(pendingRow({ hash: "0x2", firstSeenBlock: 100n }));
    store.checkpointBlock = 150n; // not yet past
    await resolveCheckpoint(store, emit, 1, 12, 50, log);
    expect([...store.rows.values()][0].status).toBe("PENDING");
    store.checkpointBlock = 151n;
    await resolveCheckpoint(store, emit, 1, 12, 50, log);
    expect([...store.rows.values()][0].status).toBe("DROPPED");
    expect(events).toHaveLength(1);
  });

  it("INCLUDED -> REORGED when its block becomes non-canonical", async () => {
    const store = new FakePendingStore();
    const { events, emit } = collect();
    await store.upsertPending(pendingRow({ hash: "0x3", status: "INCLUDED", includedBlock: 110n }));
    store.included.set("1:0x3", { hash: "0x3", sender: "0xsender", nonce: 5n, blockNumber: 110n, blockHash: "0xorphan" });
    // 0xorphan NOT in canonical set -> reorged
    store.checkpointBlock = 111n;
    await resolveCheckpoint(store, emit, 1, 12, 50, log);
    expect([...store.rows.values()][0].status).toBe("REORGED");
  });

  it("transitions are idempotent: replaying a checkpoint changes nothing", async () => {
    const store = new FakePendingStore();
    const { events, emit } = collect();
    await store.upsertPending(pendingRow({ hash: "0x4", firstSeenBlock: 100n }));
    store.checkpointBlock = 200n;
    await resolveCheckpoint(store, emit, 1, 12, 50, log);
    await resolveCheckpoint(store, emit, 1, 12, 50, log);
    expect(events.filter((e) => e.to === "DROPPED")).toHaveLength(1);
    // terminal states never transition again
    expect(await transition(store, emit, pendingRow({ hash: "0x4", status: "DROPPED" }), "INCLUDED")).toBe(false);
  });

  it("full replay: detected -> pending -> included -> confirmed; events carry status", async () => {
    const store = new FakePendingStore();
    const { events, emit } = collect();
    // DETECTED
    await store.upsertPending(pendingRow({ hash: "0x5", status: "DETECTED", sender: null, nonce: null }));
    await emit({ chainId: 1, hash: "0x5", from: null, to: "DETECTED", block: 100n });
    // PENDING (tx fetched + decoded)
    await transition(store, emit, pendingRow({ hash: "0x5", status: "DETECTED" }), "PENDING", { sender: "0xs", nonce: 1n });
    // INCLUDED + CONFIRMED via checkpoint progression
    store.included.set("1:0x5", { hash: "0x5", sender: "0xs", nonce: 1n, blockNumber: 105n, blockHash: "0xbh" });
    store.canonical.add("0xbh");
    store.checkpointBlock = 105n;
    await resolveCheckpoint(store, emit, 1, 12, 50, log);
    store.checkpointBlock = 117n;
    await resolveCheckpoint(store, emit, 1, 12, 50, log);

    expect(events.map((e) => e.to)).toEqual(["DETECTED", "PENDING", "INCLUDED", "CONFIRMED"]);
    // emitted pending_tx event carries its status — never 'confirmed'
    const ev = pendingTxEvent(1, {
      hash: "0x5", sender: "0xs", to: "0xto", value: "0",
      method: "transfer", decoded: null, status: "PENDING", firstSeenBlock: 100n,
    });
    expect(ev.kind).toBe("pending_tx");
    expect((ev.payload as { status: PendingStatus }).status).toBe("PENDING");
    expect(JSON.stringify(ev)).not.toContain('"confirmed"');
  });
});

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { normalizeBlock, normalizeLog } from "../src/normalize.js";
import { loadFixture, toSourceBlocks, toSourceLogs, type FixtureBlocks, type FixtureLogs } from "./helpers.js";
import { buildLogDedupKey } from "@nexus/shared-utils";

const schema = JSON.parse(
  readFileSync(new URL("../../../packages/event_schemas/event.schema.json", import.meta.url), "utf8")
) as { required: string[]; properties: Record<string, { type?: string | string[] }> };

describe("normalizeLog", () => {
  const { logs } = loadFixture<FixtureLogs>("logs_chain_b_fork.json");
  const raw = toSourceLogs({ logs })[0];

  it("produces all schema-required fields with correct types", () => {
    const ev = normalizeLog(raw, 1);
    for (const field of schema.required) {
      expect(ev, `missing ${field}`).toHaveProperty(field);
    }
    expect(ev.chain_id).toBe(1);
    expect(ev.kind).toBe("log");
    expect(typeof ev.dedup_key).toBe("string");
    expect(typeof ev.block_number).toBe("number");
    expect(typeof ev.tx_hash).toBe("string");
    expect(typeof ev.payload).toBe("object");
  });

  it("dedup_key is chain_id:block_hash:tx_hash:log_index", () => {
    const ev = normalizeLog(raw, 1);
    expect(ev.dedup_key).toBe(buildLogDedupKey(1, raw.blockHash, raw.transactionHash, raw.logIndex));
    expect(ev.dedup_key).toBe(`1:${raw.blockHash}:${raw.transactionHash}:${raw.logIndex}`);
  });

  it("payload carries contract, topics, data, removed flag", () => {
    const ev = normalizeLog(raw, 8453);
    expect(ev.payload.contract).toBe(raw.address);
    expect(ev.payload.topics).toEqual(raw.topics);
    expect(ev.payload.data).toBe(raw.data);
    expect(ev.payload.removed).toBe(false);
    expect(ev.log_index).toBe(raw.logIndex);
    expect(ev.block_hash).toBe(raw.blockHash);
  });
});

describe("normalizeBlock", () => {
  it("produces a block event with chain-scoped dedup key", () => {
    const { blocks } = loadFixture<FixtureBlocks>("blocks_chain_a.json");
    const raw = toSourceBlocks({ blocks })[0];
    const ev = normalizeBlock(raw, 1);
    expect(ev.kind).toBe("block");
    expect(ev.dedup_key).toBe(`1:${raw.hash}`);
    expect(ev.block_number).toBe(Number(raw.number));
    expect(ev.tx_hash).toBeNull();
    expect(ev.payload.parent_hash).toBe(raw.parentHash);
  });
});

// Capability probe: providers without pending subscriptions disable the
// chain's mempool feed explicitly — never a polling fallback.

import { describe, expect, it, vi } from "vitest";
import { createLogger } from "@nexus/shared-utils";
import { probePendingSupport, reportCapability } from "../src/capability.js";

const sink = vi.fn();
const log = createLogger("test", { sink, minLevel: "info" });

describe("pending-subscription capability probe", () => {
  it("provider that errors on subscribe -> unsupported, disabled", async () => {
    const res = await probePendingSupport((_h, onErr) => {
      setTimeout(() => onErr(new Error("method not found: eth_subscribe newPendingTransactions")), 5);
      return () => {};
    }, 500);
    expect(res.supported).toBe(false);
    reportCapability(res.supported, res.reason, 8453, log);
    const line = JSON.parse(sink.mock.calls.at(-1)![0] as string);
    expect(line.msg).toContain("disabled");
    expect(line.msg).not.toContain("polling");
  });

  it("provider that delivers a hash -> supported", async () => {
    const res = await probePendingSupport((onHash) => {
      setTimeout(() => onHash("0xabc"), 5);
      return () => {};
    }, 500);
    expect(res.supported).toBe(true);
  });

  it("quiet mempool (no hashes, no error) still counts as supported", async () => {
    const res = await probePendingSupport(() => () => {}, 50);
    expect(res.supported).toBe(true);
    expect(res.reason).toContain("timeout");
  });

  it("subscribe throwing synchronously -> unsupported", async () => {
    const res = await probePendingSupport(() => { throw new Error("unsupported"); }, 500);
    expect(res.supported).toBe(false);
  });
});

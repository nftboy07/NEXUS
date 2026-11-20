import { describe, expect, it } from "vitest";
import { createLogger } from "../src/log.js";

function capture() {
  const lines: string[] = [];
  return { lines, sink: (l: string) => lines.push(l) };
}

describe("structured logger", () => {
  it("emits single-line JSON with component and level", () => {
    const { lines, sink } = capture();
    const log = createLogger("test", { sink, minLevel: "info" });
    log.info("hello", { chain_id: 1 });
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.level).toBe("info");
    expect(entry.component).toBe("test");
    expect(entry.msg).toBe("hello");
    expect(entry.chain_id).toBe(1);
    expect(entry.ts).toBeTruthy();
  });

  it("filters below minLevel", () => {
    const { lines, sink } = capture();
    const log = createLogger("test", { sink, minLevel: "warn" });
    log.info("skip me");
    log.warn("keep me");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).level).toBe("warn");
  });

  it("child loggers merge fields", () => {
    const { lines, sink } = capture();
    const log = createLogger("test", { sink }).child({ chain: "ethereum" });
    log.error("boom", { err: "x" });
    const entry = JSON.parse(lines[0]);
    expect(entry.chain).toBe("ethereum");
    expect(entry.err).toBe("x");
  });
});

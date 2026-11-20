import { describe, expect, it } from "vitest";
import { createBackoff, retry } from "../src/backoff.js";

describe("createBackoff", () => {
  it("bounds delay by capMs", () => {
    const bo = createBackoff({ baseMs: 100, capMs: 250, maxAttempts: 10, jitter: 0 });
    expect(bo.delayMs(0)).toBe(100);
    expect(bo.delayMs(1)).toBe(200);
    expect(bo.delayMs(5)).toBe(250);
  });

  it("honors maxAttempts", () => {
    const bo = createBackoff({ maxAttempts: 3 });
    expect(bo.attemptsRemaining(2)).toBe(true);
    expect(bo.attemptsRemaining(3)).toBe(false);
  });

  it("jitter stays within the spread", () => {
    const bo = createBackoff({ baseMs: 1000, capMs: 100_000, maxAttempts: 3, jitter: 0.5 });
    for (let i = 0; i < 50; i++) {
      const d = bo.delayMs(0);
      expect(d).toBeGreaterThanOrEqual(500);
      expect(d).toBeLessThanOrEqual(1500);
    }
  });
});

describe("retry", () => {
  it("returns on first success", async () => {
    const v = await retry(async () => 42, { maxAttempts: 3, baseMs: 1 });
    expect(v).toBe(42);
  });

  it("retries then succeeds", async () => {
    let calls = 0;
    const v = await retry(
      async () => {
        calls++;
        if (calls < 3) throw new Error("flaky");
        return "ok";
      },
      { maxAttempts: 5, baseMs: 1, jitter: 0 }
    );
    expect(v).toBe("ok");
    expect(calls).toBe(3);
  });

  it("throws the last error after maxAttempts", async () => {
    let calls = 0;
    await expect(
      retry(
        async () => {
          calls++;
          throw new Error(`fail-${calls}`);
        },
        { maxAttempts: 2, baseMs: 1, jitter: 0 }
      )
    ).rejects.toThrow("fail-2");
    expect(calls).toBe(2);
  });
});

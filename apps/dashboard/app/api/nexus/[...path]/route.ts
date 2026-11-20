import { NextRequest, NextResponse } from "next/server";
import { callerIsAuthenticated } from "../../../../lib/proxyAuth";

// Server-side proxy to the NEXUS API. NEXUS_API_KEY never reaches the
// browser bundle — it is attached here, on the server only. It is also
// never attached on behalf of an unauthenticated caller: without that
// check the proxy is a confused deputy that lends the backend's
// credential to anyone who can reach this route.
const BASE = () => process.env.NEXUS_API_URL ?? "http://localhost:8000";

async function proxy(req: NextRequest, path: string[]): Promise<Response> {
  // Gate every method — including the destructive POST/DELETE — before
  // the server key is attached.
  if (!(await callerIsAuthenticated(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = `${BASE()}/` + path.join("/") + req.nextUrl.search;
  const init: RequestInit = {
    method: req.method,
    headers: {
      "X-Api-Key": process.env.NEXUS_API_KEY ?? "",
      "Content-Type": "application/json",
    },
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await req.text();
  }
  const res = await fetch(url, init);
  const body = await res.text();
  return new NextResponse(body, {
    status: res.status,
    headers: { "Content-Type": res.headers.get("content-type") ?? "application/json" },
  });
}

export async function GET(req: NextRequest, { params }: { params: { path: string[] } }) {
  return proxy(req, params.path);
}
export async function POST(req: NextRequest, { params }: { params: { path: string[] } }) {
  return proxy(req, params.path);
}
export async function DELETE(req: NextRequest, { params }: { params: { path: string[] } }) {
  return proxy(req, params.path);
}

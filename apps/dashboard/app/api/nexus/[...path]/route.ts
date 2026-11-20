import { NextRequest, NextResponse } from "next/server";

// Server-side proxy to the NEXUS API. NEXUS_API_KEY never reaches the
// browser bundle — it is attached here, on the server only.
const BASE = () => process.env.NEXUS_API_URL ?? "http://localhost:8000";

async function proxy(req: NextRequest, path: string[]): Promise<Response> {
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

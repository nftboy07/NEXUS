import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, constantTimeEquals } from "../../../lib/proxyAuth";

// Exchanges the operator token for an HttpOnly session cookie. This is
// the only route that is reachable unauthenticated.
export async function POST(req: NextRequest) {
  const expected = process.env.DASHBOARD_PROXY_TOKEN;
  if (!expected) {
    return NextResponse.json({ error: "dashboard auth not configured" }, { status: 503 });
  }
  let token = "";
  try {
    token = ((await req.json()) as { token?: string }).token ?? "";
  } catch {
    token = "";
  }
  if (!token || !(await constantTimeEquals(token, expected))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, expected, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 12,
  });
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}

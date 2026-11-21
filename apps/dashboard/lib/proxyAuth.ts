// Caller authentication for everything that is backed by the server-only
// NEXUS_API_KEY. Uses Web Crypto (not node:crypto) so the same helper
// runs in the Node runtime (route handlers) and the Edge runtime
// (middleware).
import type { NextRequest } from "next/server";

export const SESSION_COOKIE = "nx_session";

async function sha256(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return new Uint8Array(digest);
}

// Compare via fixed-length digests so neither the value nor its length
// leaks through timing.
export async function constantTimeEquals(a: string, b: string): Promise<boolean> {
  const [ah, bh] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < ah.length; i++) diff |= ah[i] ^ bh[i];
  return diff === 0;
}

export function presentedToken(req: NextRequest): string {
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  return req.cookies.get(SESSION_COOKIE)?.value ?? bearer ?? "";
}

// Fails closed: with DASHBOARD_PROXY_TOKEN unset nobody is authenticated,
// so a misconfigured deployment denies access instead of handing out the
// backend's API key.
export async function callerIsAuthenticated(req: NextRequest): Promise<boolean> {
  const expected = process.env.DASHBOARD_PROXY_TOKEN;
  if (!expected) return false;
  const presented = presentedToken(req);
  if (!presented) return false;
  return constantTimeEquals(presented, expected);
}

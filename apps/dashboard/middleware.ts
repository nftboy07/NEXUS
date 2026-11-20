import { NextRequest, NextResponse } from "next/server";
import { callerIsAuthenticated } from "./lib/proxyAuth";

// Server-rendered pages read the API with the server key as well, so an
// unauthenticated visitor must not reach them either. The proxy route
// re-checks independently (defense in depth).
export async function middleware(req: NextRequest) {
  if (await callerIsAuthenticated(req)) return NextResponse.next();
  if (req.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!login|api/session|_next/static|_next/image|favicon.ico).*)"],
};

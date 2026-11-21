# NEXUS dashboard proxy — confused-deputy authentication bypass

**Severity:** High · **Status:** fixed on `main` (see *Fix* below) · **Was exploitable by an unprivileged attacker:** yes

## Summary
The NEXUS dashboard ships a server-side proxy route that forwards any browser
request to the backend NEXUS API and **attaches the secret `NEXUS_API_KEY` to
every forwarded request without authenticating the caller**. Because
`docker-compose.yml` publishes the dashboard on `0.0.0.0:3000`, any
unprivileged attacker who can reach the dashboard port can invoke every
`NEXUS_API_KEY`-gated backend endpoint — including the destructive
`DELETE /watchlists/{id}` and the `POST` mutations — with no credentials of
their own. The proxy is a classic *confused deputy*.

## Exact location
- **File:** `apps/dashboard/app/api/nexus/[...path]/route.ts`
- **Function:** `proxy()` (reached via the exported `GET` / `POST` / `DELETE` handlers)

```ts
async function proxy(req: NextRequest, path: string[]): Promise<Response> {
  const url = `${BASE()}/` + path.join("/") + req.nextUrl.search;
  const init: RequestInit = {
    method: req.method,
    headers: {
      "X-Api-Key": process.env.NEXUS_API_KEY ?? "",   // <-- injected for ANY caller
      "Content-Type": "application/json",
    },
  };
  ...
}
```

## Root cause
The proxy performs **no authentication or authorization of the incoming
request**. It unconditionally copies the server-only `NEXUS_API_KEY` onto the
upstream request for every caller. The backend (`apps/api/main.py`,
`require_key`) correctly treats possession of `NEXUS_API_KEY` as full
authorization, so the proxy effectively hands the backend's credential to the
public. The comment in the file ("`NEXUS_API_KEY` never reaches the browser
bundle") addresses secret *leakage* but misses that the proxy *uses* the secret
on behalf of unauthenticated callers, which is equivalent to publishing it.

## Impact (unprivileged attacker, today)
Any network peer that can reach the published dashboard (`:3000`) can, with no
credentials:
- **Delete monitoring targets** — `DELETE /api/nexus/watchlists/{id}` removes
  watchlist entries, blinding the platform to the wallets/tokens/pools it was
  told to watch (integrity + availability of the core product function).
- **Create/forge data** — `POST /api/nexus/watchlists`, and
  `POST /api/nexus/investigations` (queues AI investigations, which have a real
  per-run cost per `docs/BUDGET.md`).
- **Read all key-gated intelligence** — `/alerts`, `/mev`, `/wallets/{addr}`,
  `/events`, `/pending`, `/pools`, `/investigations`, and `/system/health`
  (provider endpoints, latencies, error counts, checkpoint lag), none of which
  are meant to be public.

## Proof of concept
The original PoC (`fake_api.py` + `tests/proxy_authbypass.poc.test.ts`) drove the
real proxy route against the real FastAPI backend as an unauthenticated
attacker, and showed:
1. **Control** — hitting the backend directly with no key returns `401`
   (the endpoint really is gated).
2. **Exploit** — the same unauthenticated caller, going through the proxy,
   read `/alerts` (`200`) and **deleted watchlist id=1** (`200 {"deleted":1}`),
   after which the backend list was empty.

Both exploit steps return `401` against the fixed code. The PoC files are not
carried on `main` (they need a Python venv inside the dashboard test run);
`apps/dashboard/tests/proxy_authz.test.ts` is the standing regression test and
asserts that the backend is never reached and the key never attached for an
unauthenticated caller. `scripts/smoke.sh` check 4 re-verifies it against the
running stack: anonymous page requests redirect to `/login`, anonymous proxy
requests get `401`, and both succeed only with an operator session.

## Fix
`apps/dashboard/lib/proxyAuth.ts` authenticates the caller **before** the key is
attached, in both `proxy()` and `middleware.ts` (server-rendered pages read the
API with the same key, so they are the same surface). It compares the
`nx_session` cookie or `Authorization: Bearer` against `DASHBOARD_PROXY_TOKEN`
in constant time over SHA-256 digests, and fails closed: with the token unset
nobody is authenticated. `POST /api/session` exchanges the operator token for an
`HttpOnly`, `SameSite=Strict` cookie, so same-origin `fetch` in the client
components keeps working unchanged.

This is a single shared operator token, not per-user identity — enough to close
the bypass without inventing a user model. A real IdP or session store is the
natural follow-up.

## Submission venue
Owner's private bug-bounty / security intake for the `nftboy07/NEXUS` program
(GitHub PR on this branch holds the full write-up and runnable PoC). No real
funds, accounts, or live services were touched.

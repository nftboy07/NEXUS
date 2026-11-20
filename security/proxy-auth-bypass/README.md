# NEXUS dashboard proxy — confused-deputy authentication bypass

**Severity:** High · **Status:** PoC-verified · **Exploitable today by an unprivileged attacker:** yes

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
`apps/dashboard/tests/proxy_authbypass.poc.test.ts` drives the **real** proxy route against the
**real** FastAPI backend (started by `fake_api.py`, which runs the unmodified
`apps/api/main.py` with an in-memory DB connection so no Postgres is required —
auth and routing are untouched production code). The attacker requests carry no
`X-Api-Key` and no cookie.

The PoC shows:
1. **Control** — hitting the backend directly with no key returns `401`
   (the endpoint really is gated).
2. **Exploit** — the same unauthenticated caller, going through the proxy,
   reads `/alerts` (`200`) and **deletes watchlist id=1** (`200 {"deleted":1}`),
   after which the backend list is empty.

### Run it
```bash
# from a fresh clone of the PR branch
cd apps/api && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt && cd ../..
cd apps/dashboard && npm install && cd ../..
cd apps/dashboard && npx vitest run tests/proxy_authbypass.poc.test.ts
```
(`fake_api.py` is launched automatically by the test and uses the repo's
`apps/api/.venv` Python via the spawned `python`.)

## Fix
Authenticate/authorize the caller in the proxy before attaching the upstream
key — e.g. require an authenticated dashboard session (NextAuth / signed
session cookie) and reject unauthenticated requests, and/or restrict the proxy
to a safe allowlist of read-only paths and methods. Never attach a
server-held credential on behalf of an unauthenticated request.

## Submission venue
Owner's private bug-bounty / security intake for the `nftboy07/NEXUS` program
(GitHub PR on this branch holds the full write-up and runnable PoC). No real
funds, accounts, or live services were touched.

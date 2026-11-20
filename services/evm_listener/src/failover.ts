// Failover: on WS error/heartbeat timeout -> bounded backoff reconnect ->
// switch to secondary provider -> backfill from checkpoint -> resubscribe ->
// record the outage in provider_health.

import { createBackoff, retry, type BackoffOptions, type Logger } from "@nexus/shared-utils";
import type { EventStore } from "./store.js";
import type { ChainClients, ProviderRole } from "./rpc.js";

export interface FailoverDeps {
  chainId: number;
  chainName: string;
  store: EventStore;
  log: Logger;
  reconnect: (role: ProviderRole) => Promise<ChainClients>;
  backoff?: Partial<BackoffOptions>;
}

export interface ProviderState {
  active: ChainClients;
  outages: number;
  reconnects: number;
}

export async function recordOutage(
  store: EventStore,
  provider: string,
  chainId: number,
  latencyMs: number,
  errors: number
): Promise<void> {
  await store.recordProviderHealth({ provider, chainId, latencyMs, errors });
}

/**
 * Reconnect after a subscription failure. Retries the active provider with
 * bounded backoff; if exhausted and a secondary exists, fails over to it.
 * The caller is responsible for backfilling from the checkpoint and
 * resubscribing once this resolves.
 */
export async function recoverProvider(
  state: ProviderState,
  available: { primary: boolean; secondary: boolean },
  deps: FailoverDeps
): Promise<ProviderState> {
  const opts: BackoffOptions = {
    baseMs: deps.backoff?.baseMs ?? 1000,
    capMs: deps.backoff?.capMs ?? 30_000,
    maxAttempts: deps.backoff?.maxAttempts ?? 5,
    jitter: deps.backoff?.jitter ?? 0.2,
  };
  const role = state.active.role;
  const started = Date.now();
  state.outages++;

  try {
    const active = await retry(() => deps.reconnect(role), opts);
    state.reconnects++;
    await recordOutage(deps.store, `${deps.chainName}-${role}`, deps.chainId, Date.now() - started, 0);
    deps.log.info("reconnected to provider", { chain_id: deps.chainId, provider: role, attempt_ms: Date.now() - started });
    return { ...state, active };
  } catch (err) {
    deps.log.warn("primary reconnect attempts exhausted", { chain_id: deps.chainId, provider: role, err: String(err) });
  }

  const other: ProviderRole = role === "primary" ? "secondary" : "primary";
  if (!available[other]) {
    await recordOutage(deps.store, `${deps.chainName}-${role}`, deps.chainId, Date.now() - started, 1);
    throw new Error(`No ${other} provider configured for chain ${deps.chainId} and ${role} reconnect failed`);
  }

  const bo = createBackoff(opts);
  let lastErr: unknown;
  for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
    try {
      const active = await deps.reconnect(other);
      state.reconnects++;
      await recordOutage(deps.store, `${deps.chainName}-${other}`, deps.chainId, Date.now() - started, 0);
      deps.log.warn("failed over to secondary provider", { chain_id: deps.chainId, provider: other });
      return { ...state, active };
    } catch (err) {
      lastErr = err;
      if (attempt + 1 < opts.maxAttempts) await bo.wait(attempt);
    }
  }
  await recordOutage(deps.store, `${deps.chainName}-${other}`, deps.chainId, Date.now() - started, 1);
  throw lastErr;
}

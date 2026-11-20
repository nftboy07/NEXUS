import React from "react";
import Link from "next/link";
import { apiJson } from "@/lib/api";

type Health = { checkpoints: { chain_id: number; checkpoint: number; latest_stored_block: number | null; lag: number | null }[]; provider_health: { provider: string; chain_id: number; latency_ms: number | null; errors: number; ts: string }[]; streams: Record<string, number | null> };

export default async function Overview() {
  const [health, alerts] = await Promise.all([
    apiJson<Health>("/system/health"),
    apiJson<unknown[]>("/alerts?limit=100"),
  ]);
  return (
    <>
      <div className="card"><h2>Overview</h2>
        <p>Autonomous Blockchain Intelligence Network — deterministic detection, evidence-backed intelligence.</p>
      </div>
      {(!health || !alerts) && <div className="card error">API unavailable — {[!health && "health", !alerts && "alerts"].filter(Boolean).join(" and ")} could not be loaded.</div>}
      <div className="card"><h3>Chains</h3>
        <table><thead><tr><th>chain</th><th>checkpoint</th><th>latest stored</th><th>lag</th></tr></thead>
          <tbody>{(health?.checkpoints ?? []).map(c =>
            <tr key={c.chain_id}><td>{c.chain_id}</td><td>{c.checkpoint}</td><td>{c.latest_stored_block ?? "—"}</td><td>{c.lag ?? "—"}</td></tr>)}
          </tbody></table>
      </div>
      <div className="card"><h3>Streams</h3>
        <table><tbody>{Object.entries(health?.streams ?? {}).map(([k, v]) =>
          <tr key={k}><td>{k}</td><td>{v ?? "unavailable"}</td></tr>)}</tbody></table>
      </div>
      <div className="card"><h3>Alerts (recent)</h3>
        <p><Link href="/alerts">{alerts ? `${alerts.length} in last page` : "unavailable"}</Link></p>
      </div>
      <div className="card"><h3>Provider health</h3>
        <table><thead><tr><th>provider</th><th>chain</th><th>latency ms</th><th>errors</th><th>ts</th></tr></thead>
          <tbody>{(health?.provider_health ?? []).map((p, i) =>
            <tr key={i}><td>{p.provider}</td><td>{p.chain_id}</td><td>{p.latency_ms ?? "—"}</td><td>{p.errors}</td><td>{p.ts}</td></tr>)}
          </tbody></table>
      </div>
    </>
  );
}

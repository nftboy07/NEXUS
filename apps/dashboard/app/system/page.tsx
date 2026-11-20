import React from "react";
import { apiJson } from "@/lib/api";

type Health = { checkpoints: { chain_id: number; checkpoint: number; latest_stored_block: number | null; lag: number | null }[]; provider_health: { provider: string; chain_id: number; latency_ms: number | null; errors: number; ts: string }[]; streams: Record<string, number | null> };

export default async function System() {
  const h = await apiJson<Health>("/system/health");
  if (!h) return <div className="card error">Health endpoint unavailable.</div>;
  return (
    <>
      <div className="card"><h2>System Health</h2></div>
      <div className="card"><h3>Ingestion lag</h3>
        <table><thead><tr><th>chain</th><th>checkpoint</th><th>latest stored</th><th>lag</th></tr></thead>
          <tbody>{h.checkpoints.map(c => <tr key={c.chain_id}>
            <td>{c.chain_id}</td><td>{c.checkpoint}</td><td>{c.latest_stored_block ?? "—"}</td>
            <td>{c.lag ?? "—"}</td></tr>)}</tbody></table>
      </div>
      <div className="card"><h3>Provider health (latest)</h3>
        <table><thead><tr><th>provider</th><th>chain</th><th>latency ms</th><th>errors</th><th>ts</th></tr></thead>
          <tbody>{h.provider_health.map((p, i) => <tr key={i}>
            <td>{p.provider}</td><td>{p.chain_id}</td><td>{p.latency_ms ?? "—"}</td><td>{p.errors}</td><td>{p.ts}</td></tr>)}</tbody></table>
      </div>
      <div className="card"><h3>Stream lengths</h3>
        <table><tbody>{Object.entries(h.streams).map(([k, v]) =>
          <tr key={k}><td>{k}</td><td>{v ?? "unavailable"}</td></tr>)}</tbody></table>
      </div>
    </>
  );
}

import React from "react";
import { apiJson } from "@/lib/api";

type Alert = { id: number; kind: string | null; source_engine: string | null; chain_id: number | null; delivery_state: string | null; created_at: string; record?: { title?: string } | null; deliveries?: { channel: string; state: string; attempts: number }[] };

export default async function Alerts() {
  const rows = (await apiJson<Alert[]>("/alerts?limit=100")) ?? [];
  return (
    <div className="card"><h2>Alerts</h2>
      <table><thead><tr><th>id</th><th>engine</th><th>kind</th><th>chain</th><th>state</th><th>channels</th><th>created</th></tr></thead>
        <tbody>{rows.map(a => <tr key={a.id}>
          <td><a href={`/alerts/${a.id}`}>{a.id}</a></td>
          <td>{a.source_engine}</td><td>{a.kind}</td><td>{a.chain_id}</td>
          <td>{a.delivery_state}</td>
          <td>{(a.deliveries ?? []).map(d => `${d.channel}:${d.state}`).join(", ")}</td>
          <td>{a.created_at}</td></tr>)}
        </tbody></table>
    </div>
  );
}

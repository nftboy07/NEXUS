import React from "react";
import { apiJson } from "@/lib/api";
import { TxLink } from "@/components/ExplorerLink";

type Alert = { id: number; kind: string | null; chain_id: number | null; created_at: string; record?: { title?: string; facts?: Record<string, unknown> } | null };

export default async function Whale() {
  const alerts = (await apiJson<Alert[]>("/alerts?limit=100")) ?? [];
  const whales = alerts.filter(a => (a.kind ?? "").includes("whale"));
  return (
    <div className="card"><h2>Whale Radar</h2>
      <p>Large-movement alerts emitted by Engine 3 (threshold-gated; amounts are token units — no USD price source is configured).</p>
      <table><thead><tr><th>id</th><th>title</th><th>tx</th><th>created</th></tr></thead>
        <tbody>{whales.map(a => <tr key={a.id}>
          <td><a href={`/alerts/${a.id}`}>{a.id}</a></td>
          <td>{a.record?.title ?? a.kind}</td>
          <td><TxLink chainId={a.chain_id ?? 1} tx={(a.record?.facts?.tx_hash as string) ?? null} /></td>
          <td>{a.created_at}</td></tr>)}
        </tbody></table>
    </div>
  );
}

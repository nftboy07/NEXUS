import React from "react";
import { apiJson } from "@/lib/api";
import { TxLink, AddrLink, BlockLink } from "@/components/ExplorerLink";

type Finding = { id: number; chain_id: number; block_number: number; kind: string; initiator: string | null; victim: string | null; pool_id: string | null; evidence: { tx_hash?: string }[] | null; estimated_impact: Record<string, unknown> | null; confidence: { level?: string; rationale?: string } | null };

export default async function Mev() {
  const rows = (await apiJson<Finding[]>("/mev?limit=100")) ?? [];
  return (
    <div className="card"><h2>MEV Monitor</h2>
      <p>Deterministic findings only — &quot;potential&quot; patterns, never claimed intent. Values are estimates unless marked otherwise.</p>
      <table><thead><tr><th>kind</th><th>block</th><th>evidence txs</th><th>initiator</th><th>victim</th><th>confidence</th></tr></thead>
        <tbody>{rows.map(f => <tr key={f.id}>
          <td>{f.kind}</td>
          <td><BlockLink chainId={f.chain_id} block={f.block_number} /></td>
          <td>{(f.evidence ?? []).map((e, i) => <span key={i}><TxLink chainId={f.chain_id} tx={e.tx_hash} /> </span>)}</td>
          <td><AddrLink chainId={f.chain_id} addr={f.initiator} /></td>
          <td><AddrLink chainId={f.chain_id} addr={f.victim} /></td>
          <td title={f.confidence?.rationale}>{f.confidence?.level ?? "—"}</td></tr>)}
        </tbody></table>
    </div>
  );
}

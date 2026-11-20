import React from "react";
import { apiJson } from "@/lib/api";
import { StatusBadge } from "@/components/StatusBadge";
import { TxLink, AddrLink, BlockLink } from "@/components/ExplorerLink";

type Pending = { chain_id: number; hash: string; sender: string; nonce: number; recipient: string | null; value: string | null; method: string | null; status: string; first_seen_block: number | null; included_block: number | null; replaced_by: string | null };

export default async function Mempool() {
  const rows = await apiJson<Pending[]>("/pending?limit=100");
  return (
    <div className="card"><h2>Mempool Intelligence</h2>
      <p>Pending mempool observations. <b>PENDING states are unconfirmed</b> — provider visibility is partial and node-specific.</p>
      <table><thead><tr><th>status</th><th>tx</th><th>sender</th><th>method</th><th>first seen</th><th>included</th><th>replaced by</th></tr></thead>
        <tbody>{(rows ?? []).map(p => <tr key={p.hash}>
          <td><StatusBadge status={p.status} /></td>
          <td><TxLink chainId={p.chain_id} tx={p.hash} /></td>
          <td><AddrLink chainId={p.chain_id} addr={p.sender} /></td>
          <td>{p.method ?? "unknown"}</td>
          <td><BlockLink chainId={p.chain_id} block={p.first_seen_block} /></td>
          <td><BlockLink chainId={p.chain_id} block={p.included_block} /></td>
          <td>{p.replaced_by ? <TxLink chainId={p.chain_id} tx={p.replaced_by} /> : "—"}</td></tr>)}
        </tbody></table>
    </div>
  );
}

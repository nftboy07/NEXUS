import React from "react";
import { apiJson } from "@/lib/api";
import { AddrLink, BlockLink } from "@/components/ExplorerLink";

type Pool = { id: string; dex: string; token0: string; token1: string; chain_id: number; fee_tier: number | null; created_block: number | null; discovery: string | null };

export default async function Dex() {
  const pools = (await apiJson<Pool[]>("/pools?limit=100")) ?? [];
  return (
    <div className="card"><h2>DEX & Liquidity Radar</h2>
      <p>Registered pools (Engine 4). Reserves come from Sync events and swap-derived snapshots.</p>
      <table><thead><tr><th>pool</th><th>dex</th><th>tokens</th><th>discovery</th><th>created</th></tr></thead>
        <tbody>{pools.map(p => <tr key={p.id}>
          <td><AddrLink chainId={p.chain_id} addr={p.id} /></td>
          <td>{p.dex}</td>
          <td><AddrLink chainId={p.chain_id} addr={p.token0} /> / <AddrLink chainId={p.chain_id} addr={p.token1} /></td>
          <td>{p.discovery}</td>
          <td><BlockLink chainId={p.chain_id} block={p.created_block} /></td></tr>)}
        </tbody></table>
    </div>
  );
}

import React from "react";
import { apiJson } from "@/lib/api";
import { TxLink, BlockLink } from "@/components/ExplorerLink";

type Inv = { id: number; trigger: string; chain_id: number | null; trigger_tx: string | null; status: string; citations_valid: boolean | null; confidence: string | null; model: string | null; cost_estimate: string | null; created_at: string; report?: { findings?: { kind?: string; statement?: string; citations?: string[] }[]; citations?: { tx_hash?: string; block_number?: number }[] } | null };

export default async function Investigations() {
  const rows = (await apiJson<Inv[]>("/investigations?limit=50")) ?? [];
  return (
    <div className="card"><h2>AI Investigations</h2>
      <p>Manual-trigger investigations. Reports failing citation validation are flagged <b>unverified</b>, never presented as verified.</p>
      {rows.map(inv => (
        <section key={inv.id}>
          <h3>#{inv.id} — {inv.status}{inv.citations_valid === false ? " (unverified)" : ""}</h3>
          <p>trigger: {inv.trigger} · model: {inv.model ?? "—"} · confidence: {inv.confidence ?? "—"} · cost: {inv.cost_estimate ?? "unknown"}</p>
          {inv.report?.findings?.map((f, i) => (
            <p key={i}>[{f.kind}] {f.statement}</p>
          ))}
          {inv.report?.citations?.map((c, i) => (
            <p key={i}>evidence: <TxLink chainId={inv.chain_id ?? 1} tx={c.tx_hash} /> @ <BlockLink chainId={inv.chain_id ?? 1} block={c.block_number} /></p>
          ))}
        </section>
      ))}
    </div>
  );
}

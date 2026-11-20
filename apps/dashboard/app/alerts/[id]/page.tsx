import React from "react";
import { apiJson } from "@/lib/api";
import { TxLink, AddrLink, BlockLink } from "@/components/ExplorerLink";

type Alert = { id: number; kind: string | null; source_engine: string | null; chain_id: number | null; delivery_state: string | null; created_at: string; record?: { title?: string; facts?: Record<string, unknown>; assessment?: { confidence?: string; alternatives?: unknown[]; missing_info?: unknown[] } } | null; deliveries?: { channel: string; state: string; attempts: number; last_error: string | null }[] };

export default async function AlertDetail({ params }: { params: { id: string } }) {
  const a = await apiJson<Alert>(`/alerts/${params.id}`);
  if (!a) return <div className="card error">Alert not found.</div>;
  const rec = a.record;
  const chainId = a.chain_id ?? 1;
  const facts = rec?.facts ?? {};
  return (
    <div className="card"><h2>Alert #{a.id} — {rec?.title ?? a.kind}</h2>
      <p>engine: {a.source_engine} · chain: {a.chain_id} · state: {a.delivery_state} · {a.created_at}</p>
      <section><h3>Facts</h3>
        <table><tbody>{Object.entries(facts).map(([k, v]) => (
          <tr key={k}><td>{k}</td><td>
            {k === "tx_hash" ? <TxLink chainId={chainId} tx={String(v)} />
              : k.includes("block") && typeof v === "number" ? <BlockLink chainId={chainId} block={v} />
              : typeof v === "string" && v.startsWith("0x") ? <AddrLink chainId={chainId} addr={v} />
              : <code>{JSON.stringify(v)}</code>}</td></tr>))}
        </tbody></table>
      </section>
      <section><h3>Assessment</h3>
        {rec?.assessment ? (<>
          <p>confidence: {rec.assessment.confidence ?? "—"}</p>
          {(rec.assessment.alternatives ?? []).map((x, i) => <p key={i}>alternative: {JSON.stringify(x)}</p>)}
          {(rec.assessment.missing_info ?? []).map((x, i) => <p key={i}>missing: {JSON.stringify(x)}</p>)}
        </>) : <p>No assessment supplied.</p>}
      </section>
      <section><h3>Deliveries</h3>
        <table><tbody>{(a.deliveries ?? []).map((d, i) =>
          <tr key={i}><td>{d.channel}</td><td>{d.state}</td><td>{d.attempts}</td><td>{d.last_error ?? ""}</td></tr>)}
        </tbody></table>
      </section>
    </div>
  );
}

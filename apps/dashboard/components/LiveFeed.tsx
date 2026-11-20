"use client";
import React, { useEffect, useState } from "react";
import { TxLink, AddrLink, BlockLink } from "./ExplorerLink";

type Alert = { id: number; kind: string | null; source_engine: string | null; chain_id: number | null; delivery_state: string | null; created_at: string; record?: { title?: string; facts?: Record<string, unknown> } | null };
type Event = { tx_hash: string; block_number: number; address: string };

export default function LiveFeed({ chainId }: { chainId: number }) {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  useEffect(() => {
    let live = true;
    async function tick() {
      const [a, e] = await Promise.all([
        fetch("/api/nexus/alerts?limit=25").then(r => r.ok ? r.json() : []),
        fetch(`/api/nexus/events?chain_id=${chainId}&limit=25`).then(r => r.ok ? r.json() : []),
      ]);
      if (live) { setAlerts(a); setEvents(e); }
    }
    tick();
    const t = setInterval(tick, 10000);
    return () => { live = false; clearInterval(t); };
  }, [chainId]);
  return (
    <>
      <div className="card"><h3>Recent alerts</h3>
        <table><thead><tr><th>id</th><th>engine</th><th>kind</th><th>delivery</th><th>created</th></tr></thead>
          <tbody>{alerts.map(a => <tr key={a.id}>
            <td>{a.id}</td><td>{a.source_engine}</td><td>{a.kind}</td>
            <td>{a.delivery_state}</td><td>{a.created_at}</td></tr>)}
          </tbody></table>
      </div>
      <div className="card"><h3>Recent events (chain {chainId})</h3>
        <table><thead><tr><th>tx</th><th>block</th><th>contract</th></tr></thead>
          <tbody>{events.map((e, i) => <tr key={i}>
            <td><TxLink chainId={chainId} tx={e.tx_hash} /></td>
            <td><BlockLink chainId={chainId} block={e.block_number} /></td>
            <td><AddrLink chainId={chainId} addr={e.address} /></td></tr>)}
          </tbody></table>
      </div>
    </>
  );
}

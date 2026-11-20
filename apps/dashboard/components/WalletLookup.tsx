"use client";
import React, { useState } from "react";

type Profile = { address: string; score: number | null; coverage: number | null; components: Record<string, unknown> | null };

export default function WalletLookup() {
  const [addr, setAddr] = useState("");
  const [res, setRes] = useState<Profile | "notfound" | null>(null);
  async function lookup() {
    const r = await fetch(`/api/nexus/wallets/${addr.toLowerCase()}`);
    setRes(r.ok ? await r.json() : "notfound");
  }
  return (
    <>
      <input value={addr} onChange={e => setAddr(e.target.value)} placeholder="0x…" size={44} />
      <button onClick={lookup}>Lookup</button>
      {res === "notfound" && <p className="error">Wallet not tracked.</p>}
      {res && res !== "notfound" && (
        <section>
          <h3>{res.address}</h3>
          <p>score: {res.score ?? "insufficient data"} · coverage: {res.coverage ?? "—"}</p>
          <pre>{JSON.stringify(res.components, null, 2)}</pre>
        </section>
      )}
    </>
  );
}

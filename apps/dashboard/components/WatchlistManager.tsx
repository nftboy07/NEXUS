"use client";
import React, { useEffect, useState } from "react";

type Row = { id: number; kind: string; value: string; note: string | null };

export default function WatchlistManager() {
  const [rows, setRows] = useState<Row[]>([]);
  const [kind, setKind] = useState("wallet");
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");

  async function refresh() {
    const r = await fetch("/api/nexus/watchlists");
    if (r.ok) setRows(await r.json());
  }
  useEffect(() => { refresh(); }, []);

  async function add() {
    await fetch("/api/nexus/watchlists", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, value, note: note || null }),
    });
    setValue(""); setNote("");
    refresh();
  }
  async function remove(id: number) {
    await fetch(`/api/nexus/watchlists/${id}`, { method: "DELETE" });
    refresh();
  }
  return (
    <>
      <div>
        <select value={kind} onChange={e => setKind(e.target.value)}>
          <option value="wallet">wallet</option><option value="token">token</option><option value="pool">pool</option>
        </select>
        <input value={value} onChange={e => setValue(e.target.value)} placeholder="0x…" size={44} />
        <input value={note} onChange={e => setNote(e.target.value)} placeholder="note" />
        <button onClick={add}>Add</button>
      </div>
      <table><thead><tr><th>id</th><th>kind</th><th>value</th><th>note</th><th></th></tr></thead>
        <tbody>{rows.map(r => <tr key={r.id}>
          <td>{r.id}</td><td>{r.kind}</td><td><code>{r.value}</code></td><td>{r.note}</td>
          <td><button onClick={() => remove(r.id)}>delete</button></td></tr>)}
        </tbody></table>
    </>
  );
}

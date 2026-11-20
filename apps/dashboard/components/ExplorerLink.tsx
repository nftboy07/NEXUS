import React from "react";
import { explorerTx, explorerAddress, explorerBlock } from "@/lib/explorers";

export function short(v?: string | null, n = 10): string {
  if (!v) return "—";
  return v.length > n + 4 ? `${v.slice(0, n)}…${v.slice(-4)}` : v;
}

export function TxLink({ chainId, tx }: { chainId: number; tx?: string | null }) {
  const url = tx ? explorerTx(chainId, tx) : null;
  if (!tx) return <>—</>;
  if (!url) return <code>{short(tx)}</code>;
  return <a href={url} target="_blank" rel="noreferrer"><code>{short(tx)}</code></a>;
}

export function AddrLink({ chainId, addr }: { chainId: number; addr?: string | null }) {
  const url = addr ? explorerAddress(chainId, addr) : null;
  if (!addr) return <>—</>;
  if (!url) return <code>{short(addr)}</code>;
  return <a href={url} target="_blank" rel="noreferrer"><code>{short(addr)}</code></a>;
}

export function BlockLink({ chainId, block }: { chainId: number; block?: number | null }) {
  const url = block != null ? explorerBlock(chainId, block) : null;
  if (block == null) return <>—</>;
  if (!url) return <code>{block}</code>;
  return <a href={url} target="_blank" rel="noreferrer"><code>{block}</code></a>;
}

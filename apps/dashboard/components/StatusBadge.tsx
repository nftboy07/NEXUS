import React from "react";

const PENDING_STATES = new Set(["DETECTED", "PENDING"]);

export function StatusBadge({ status }: { status?: string | null }) {
  const s = (status ?? "unknown").toUpperCase();
  const pending = PENDING_STATES.has(s);
  return (
    <span className={pending ? "badge pending" : "badge"}>
      {pending ? `${s} — UNCONFIRMED` : s}
    </span>
  );
}

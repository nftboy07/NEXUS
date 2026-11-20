import React from "react";
import WalletLookup from "@/components/WalletLookup";

export default function Wallets() {
  return (
    <div className="card"><h2>Wallet Intelligence</h2>
      <p>Engine 3 composite scores — provenance-tagged components only; fields with insufficient evidence are absent, never fabricated.</p>
      <WalletLookup />
    </div>
  );
}

import React from "react";
import Link from "next/link";

const PAGES: [string, string][] = [
  ["/", "Overview"], ["/feed", "Live Feed"], ["/mempool", "Mempool"],
  ["/wallets", "Wallet Intelligence"], ["/whale", "Whale Radar"],
  ["/dex", "DEX Radar"], ["/mev", "MEV Monitor"],
  ["/investigations", "AI Investigations"], ["/watchlists", "Watchlists"],
  ["/alerts", "Alerts"], ["/system", "System Health"],
];

export default function Nav() {
  return (
    <nav>
      <h1>NEXUS <span>by Crypto Relic</span></h1>
      <ul>{PAGES.map(([href, label]) => <li key={href}><Link href={href}>{label}</Link></li>)}</ul>
    </nav>
  );
}

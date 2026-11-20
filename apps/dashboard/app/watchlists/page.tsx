import React from "react";
import WatchlistManager from "@/components/WatchlistManager";

export default function Watchlists() {
  return (
    <div className="card"><h2>Watchlists</h2>
      <p>Rule-bearing watchlist entries feed Engines 2–4 alert criteria.</p>
      <WatchlistManager />
    </div>
  );
}

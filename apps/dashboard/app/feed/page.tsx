import React from "react";
import LiveFeed from "@/components/LiveFeed";

export default function Feed() {
  return (<><div className="card"><h2>Live Feed</h2><p>Auto-refreshing every 10s.</p></div>
    <LiveFeed chainId={1} /></>);
}

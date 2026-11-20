import "dotenv/config";
import { createPublicClient, webSocket, parseAbiItem } from "viem";
import { mainnet } from "viem/chains";

// NEXUS starter listener — confirmed ERC-20 Transfer events on Ethereum.
// Not production-ready yet: no durable storage, backfill, reconnection
// policy, reorg handling, or multi-chain config. See docs/roadmap.md Phase 1.

const url = process.env.WSS_RPC_URL;
if (!url) throw new Error("Missing WSS_RPC_URL");

const client = createPublicClient({ chain: mainnet, transport: webSocket(url) });

const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)"
);

async function startListener() {
  console.log("Starting Ethereum transfer listener...");
  const unwatch = client.watchEvent({
    event: transferEvent,
    onLogs(logs) {
      for (const log of logs) {
        console.log({
          transactionHash: log.transactionHash,
          blockNumber: log.blockNumber?.toString(),
          from: log.args.from,
          to: log.args.to,
          value: log.args.value?.toString(),
        });
      }
    },
    onError(error) { console.error("Listener error:", error); },
  });
  return unwatch;
}

startListener().catch((error) => {
  console.error("Fatal listener error:", error);
  process.exitCode = 1;
});

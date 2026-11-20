// viemChainSource.getLogs must send topics/address to eth_getLogs verbatim.
import { describe, expect, it } from "vitest";
import type { PublicClient } from "viem";
import { viemChainSource } from "../src/rpc.js";

describe("viemChainSource.getLogs", () => {
  it("passes topics (incl. null wildcards) and address to raw eth_getLogs", async () => {
    const calls: unknown[] = [];
    const client = {
      request: async (args: unknown) => {
        calls.push(args);
        return [{
          address: "0x00000000000000000000000000000000000000aa",
          blockHash: "0x" + "b".repeat(64),
          blockNumber: "0x10",
          transactionHash: "0x" + "c".repeat(64),
          transactionIndex: "0x1",
          logIndex: "0x2",
          data: "0x",
          topics: ["0x" + "d".repeat(64)],
          removed: false,
        }];
      },
    } as unknown as PublicClient;
    const topics = [["0x" + "d".repeat(64)], null, ["0x" + "e".repeat(64)]];
    const logs = await viemChainSource(client).getLogs({ topics, address: ["0xaa"], fromBlock: 16n, toBlock: 32n });
    expect(calls).toEqual([{
      method: "eth_getLogs",
      params: [{ address: ["0xaa"], topics, fromBlock: "0x10", toBlock: "0x20" }],
    }]);
    expect(logs[0]).toMatchObject({ blockNumber: 16n, logIndex: 2, transactionIndex: 1 });
  });
});

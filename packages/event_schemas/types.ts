// TypeScript types matching packages/event_schemas/event.schema.json exactly.
// The schema is the contract of record; keep this file in sync with it.

export type NexusEventKind = "block" | "log" | "transfer" | "pending_tx" | "liquidity" | "block_removed";

export interface NexusNormalizedEvent {
  /** chain_id:block_hash:tx_hash:log_index for logs */
  dedup_key: string;
  chain_id: number;
  kind: NexusEventKind;
  block_number: number | null;
  tx_hash: string | null;
  block_hash?: string | null;
  log_index?: number | null;
  payload: Record<string, unknown>;
}

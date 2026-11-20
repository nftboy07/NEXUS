// XADD normalized events to Redis stream `nexus:events`.

import type { NexusNormalizedEvent } from "@nexus/event-schemas";

export const EVENTS_STREAM = "nexus:events";

export interface EventPublisher {
  publish(event: NexusNormalizedEvent): Promise<void>;
  close(): Promise<void>;
}

/** Minimal redis client surface so tests can inject fakes. */
export interface RedisLike {
  xAdd(key: string, id: string, fields: Record<string, string>): Promise<unknown>;
  quit(): Promise<unknown>;
}

export class RedisPublisher implements EventPublisher {
  constructor(
    private redis: RedisLike,
    private stream: string = EVENTS_STREAM
  ) {}

  async publish(event: NexusNormalizedEvent): Promise<void> {
    await this.redis.xAdd(this.stream, "*", {
      dedup_key: event.dedup_key,
      chain_id: String(event.chain_id),
      kind: event.kind,
      event: JSON.stringify(event),
    });
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}

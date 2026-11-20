// Bounded exponential backoff with jitter + max attempts.
// Delay for attempt n (0-based): min(capMs, baseMs * 2^n) * jitter factor.

export interface BackoffOptions {
  baseMs?: number;
  capMs?: number;
  maxAttempts: number;
  jitter?: number; // 0..1 fraction of delay randomized
}

export interface Backoff {
  delayMs(attempt: number): number;
  wait(attempt: number): Promise<void>;
  attemptsRemaining(attempt: number): boolean;
  readonly maxAttempts: number;
}

export function createBackoff(opts: BackoffOptions): Backoff {
  const baseMs = opts.baseMs ?? 1000;
  const capMs = opts.capMs ?? 30_000;
  const jitter = opts.jitter ?? 0.2;
  return {
    maxAttempts: opts.maxAttempts,
    attemptsRemaining: (attempt) => attempt < opts.maxAttempts,
    delayMs(attempt: number): number {
      const exp = Math.min(capMs, baseMs * 2 ** attempt);
      const spread = exp * jitter;
      return Math.round(exp - spread + Math.random() * spread * 2);
    },
    wait(attempt: number): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, this.delayMs(attempt)));
    },
  };
}

/** Run fn, retrying on throw with bounded backoff. Throws the last error after maxAttempts. */
export async function retry<T>(fn: () => Promise<T>, opts: BackoffOptions): Promise<T> {
  const bo = createBackoff(opts);
  let lastErr: unknown;
  for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt + 1 < opts.maxAttempts) await bo.wait(attempt);
    }
  }
  throw lastErr;
}

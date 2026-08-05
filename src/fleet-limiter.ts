export class FleetLimiter {
  private activeCount = 0;
  private readonly waiters: Array<() => void> = [];
  readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Fleet limit must be a positive integer");
  }

  get active(): number { return this.activeCount; }
  get queued(): number { return this.waiters.length; }
  get available(): number { return Math.max(0, this.limit - this.activeCount); }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new Error("Agent launch cancelled");
    if (this.activeCount < this.limit) {
      this.activeCount++;
      return this.releaseFactory();
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter = () => { cleanup(); this.activeCount++; resolve(this.releaseFactory()); };
      const abort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        cleanup();
        reject(new Error("Agent launch cancelled"));
      };
      const cleanup = () => signal?.removeEventListener("abort", abort);
      signal?.addEventListener("abort", abort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private releaseFactory(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeCount--;
      this.waiters.shift()?.();
    };
  }
}

const sessionLimiters = new Map<string, FleetLimiter>();

export function sessionFleetLimiter(sessionId: string, limit: number): FleetLimiter {
  const existing = sessionLimiters.get(sessionId);
  if (existing) return existing;
  const limiter = new FleetLimiter(limit);
  sessionLimiters.set(sessionId, limiter);
  return limiter;
}

export function clearSessionFleetLimiters(): void {
  sessionLimiters.clear();
}

/**
 * ResponseCache — a tiny in-process TTL cache for read responses.
 *
 * Workspace read traffic from an assistant is bursty and repetitive (the same
 * "what's on my calendar today" question hits the same query within seconds).
 * A short-lived per-process cache absorbs that without risking stale writes:
 * the TTL is small (default 60s) and the cache is read-only — every write
 * (create event, send mail, …) bypasses it and clears it entirely.
 *
 * Keys are caller-constructed and SHOULD include the impersonated subject so
 * one user's cached reads can never be served to another.
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export interface ResponseCacheOptions {
  /** Time-to-live for a cached entry, in milliseconds. Default 60_000 (60s). */
  readonly ttlMs?: number;
  /** Max entries kept before the oldest are evicted. Default 500. */
  readonly maxEntries?: number;
}

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 500;

export class ResponseCache {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly store = new Map<string, CacheEntry<unknown>>();

  constructor(opts: ResponseCacheOptions = {}) {
    this.ttlMs = opts.ttlMs && opts.ttlMs > 0 ? opts.ttlMs : DEFAULT_TTL_MS;
    this.maxEntries =
      opts.maxEntries && opts.maxEntries > 0 ? opts.maxEntries : DEFAULT_MAX_ENTRIES;
  }

  /** Return a fresh cached value, or undefined on miss/expiry. */
  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  /** Store a value under `key`, evicting the oldest entry past capacity. */
  set<T>(key: string, value: T): void {
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  /**
   * Read-through helper: return the cached value or run `producer`, caching its
   * result. Concurrent callers with the same key may both run the producer —
   * acceptable for idempotent reads.
   */
  async getOrSet<T>(key: string, producer: () => Promise<T>): Promise<T> {
    const hit = this.get<T>(key);
    if (hit !== undefined) return hit;
    const value = await producer();
    this.set(key, value);
    return value;
  }

  /** Drop everything (e.g. after a write the caller knows invalidates reads). */
  clear(): void {
    this.store.clear();
  }
}

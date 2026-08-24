import type { ResearchSource } from "./research.ts";

export interface ResearchSourcePolicy {
  timeoutMs: number;
  maxAttempts: number;
  retryDelayMs: number;
  minIntervalMs: number;
  cacheTtlMs: number;
}

const SOURCE_POLICIES: Record<ResearchSource, ResearchSourcePolicy> = {
  Crossref: {
    timeoutMs: 18_000,
    maxAttempts: 3,
    retryDelayMs: 350,
    minIntervalMs: 250,
    cacheTtlMs: 5 * 60_000,
  },
  OpenAlex: {
    timeoutMs: 18_000,
    maxAttempts: 3,
    retryDelayMs: 350,
    minIntervalMs: 250,
    cacheTtlMs: 5 * 60_000,
  },
  arXiv: {
    timeoutMs: 20_000,
    maxAttempts: 3,
    retryDelayMs: 500,
    minIntervalMs: 750,
    cacheTtlMs: 5 * 60_000,
  },
  "Semantic Scholar": {
    timeoutMs: 18_000,
    maxAttempts: 3,
    retryDelayMs: 600,
    minIntervalMs: 1_000,
    cacheTtlMs: 5 * 60_000,
  },
  PubMed: {
    timeoutMs: 18_000,
    maxAttempts: 3,
    retryDelayMs: 350,
    minIntervalMs: 350,
    cacheTtlMs: 5 * 60_000,
  },
};

export const researchSourcePolicy = (
  source: ResearchSource,
): ResearchSourcePolicy => SOURCE_POLICIES[source];

interface ResponseCacheEntry {
  value: string;
  expiresAt: number;
  size: number;
}

export interface ResearchResponseCacheOptions {
  maxEntries?: number;
  maxBytes?: number;
}

/**
 * A bounded, successful-response-only cache. Keeping it behind the source
 * runner means UI workflows never need to know whether a response came from
 * the network or a recent lookup.
 */
export class ResearchResponseCache {
  readonly maxEntries: number;
  readonly maxBytes: number;
  #entries = new Map<string, ResponseCacheEntry>();
  #totalBytes = 0;

  constructor({ maxEntries = 128, maxBytes = 8 * 1024 * 1024 } = {}) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
  }

  get(key: string, now = Date.now()): string | undefined {
    const entry = this.#entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= now) {
      this.#delete(key, entry);
      return undefined;
    }
    // Promote recently used entries so eviction approximates LRU behavior.
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: string, ttlMs: number, now = Date.now()): void {
    const size = value.length * 2;
    if (size > this.maxBytes || ttlMs <= 0) {
      return;
    }
    const previous = this.#entries.get(key);
    if (previous) {
      this.#delete(key, previous);
    }
    const entry = { value, expiresAt: now + ttlMs, size };
    this.#entries.set(key, entry);
    this.#totalBytes += size;
    while (
      this.#entries.size > this.maxEntries ||
      this.#totalBytes > this.maxBytes
    ) {
      const oldest = this.#entries.entries().next().value as
        [string, ResponseCacheEntry] | undefined;
      if (!oldest) {
        break;
      }
      this.#delete(oldest[0], oldest[1]);
    }
  }

  clear(): void {
    this.#entries.clear();
    this.#totalBytes = 0;
  }

  #delete(key: string, entry: ResponseCacheEntry): void {
    this.#entries.delete(key);
    this.#totalBytes -= entry.size;
  }
}

export interface ResearchSourceClientOptions {
  cache?: ResearchResponseCache;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  policies?: Partial<Record<ResearchSource, ResearchSourcePolicy>>;
}

export type ResearchSourceRequest = (signal: AbortSignal) => Promise<string>;

const defaultSleep = (milliseconds: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });

const errorMessage = (reason: unknown): string =>
  reason instanceof Error ? reason.message : String(reason);

const isRetryable = (reason: unknown): boolean => {
  const message = errorMessage(reason);
  return (
    /(?:^|\s)(?:408|425|429|5\d{2})(?:\s|$)/.test(message) ||
    /(abort|fetch|network|timeout|timed out|连接|超时|暂时不可用)/i.test(
      message,
    )
  );
};

const withTimeout = async (
  request: ResearchSourceRequest,
  source: ResearchSource,
  timeoutMs: number,
): Promise<string> => {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        reject(new Error(`${source} 请求超时（${timeoutMs}ms）。`));
      }, timeoutMs);
    });
    return await Promise.race([request(controller.signal), timeout]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
};

/**
 * Shared source adapter seam. It owns the operational policy while each
 * source-specific parser only provides URL construction and response mapping.
 */
export class ResearchSourceClient {
  readonly cache: ResearchResponseCache;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly policies: Record<ResearchSource, ResearchSourcePolicy>;
  #nextAllowedAt = new Map<ResearchSource, number>();
  #inFlight = new Map<string, Promise<string>>();

  constructor(options: ResearchSourceClientOptions = {}) {
    this.cache = options.cache ?? new ResearchResponseCache();
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.policies = {
      ...SOURCE_POLICIES,
      ...options.policies,
    };
  }

  async fetch(
    source: ResearchSource,
    key: string,
    request: ResearchSourceRequest,
  ): Promise<string> {
    const cached = this.cache.get(key, this.now());
    if (cached !== undefined) {
      return cached;
    }

    const inFlight = this.#inFlight.get(key);
    if (inFlight) {
      return inFlight;
    }

    const pending = this.#fetchWithPolicy(source, key, request);
    this.#inFlight.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.#inFlight.get(key) === pending) {
        this.#inFlight.delete(key);
      }
    }
  }

  async #fetchWithPolicy(
    source: ResearchSource,
    key: string,
    request: ResearchSourceRequest,
  ): Promise<string> {
    const policy = this.policies[source];
    let lastError: unknown;
    for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
      await this.#waitForSlot(source, policy.minIntervalMs);
      try {
        const body = await withTimeout(request, source, policy.timeoutMs);
        this.cache.set(key, body, policy.cacheTtlMs, this.now());
        return body;
      } catch (reason) {
        lastError = reason;
        if (attempt >= policy.maxAttempts || !isRetryable(reason)) {
          throw reason;
        }
        await this.sleep(policy.retryDelayMs * 2 ** (attempt - 1));
      }
    }
    throw lastError ?? new Error(`${source} 请求失败。`);
  }

  async #waitForSlot(
    source: ResearchSource,
    minIntervalMs: number,
  ): Promise<void> {
    const now = this.now();
    const nextAllowedAt = this.#nextAllowedAt.get(source) ?? now;
    const waitMs = Math.max(0, nextAllowedAt - now);
    // Reserve the next slot before yielding so concurrent calls cannot both
    // bypass the per-source limit.
    this.#nextAllowedAt.set(
      source,
      Math.max(now, nextAllowedAt) + minIntervalMs,
    );
    if (waitMs > 0) {
      await this.sleep(waitMs);
    }
  }
}

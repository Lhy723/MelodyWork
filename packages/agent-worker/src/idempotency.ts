import { createHash } from "node:crypto";

export interface IdempotencyClaim {
  key: string;
  fingerprint: string;
  runId: string;
}

export type IdempotencyClaimResult =
  | { kind: "accepted"; claim: IdempotencyClaim }
  | { kind: "duplicate"; claim: IdempotencyClaim }
  | { kind: "conflict"; claim: IdempotencyClaim };

const DEFAULT_MAX_CLAIMS = 256;

const normalizedLimit = (value: number | undefined): number =>
  value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : DEFAULT_MAX_CLAIMS;

/**
 * A bounded, per-session ledger for execution idempotency keys.
 *
 * Keeping completed claims until the session closes makes a retried frame a
 * no-op instead of starting a second model turn. The bounded FIFO eviction is
 * only a memory guard; callers should use a durable event log when they need
 * to replay the original result rather than merely suppress a duplicate.
 */
export class IdempotencyLedger {
  private readonly claims = new Map<string, IdempotencyClaim>();
  private readonly maxClaims: number;

  public constructor(maxClaims?: number) {
    this.maxClaims = normalizedLimit(maxClaims);
  }

  public claim(
    key: string,
    fingerprint: string,
    runId: string,
  ): IdempotencyClaimResult {
    const normalizedKey = key.trim();
    const existing = this.claims.get(normalizedKey);
    if (existing) {
      return {
        kind: existing.fingerprint === fingerprint ? "duplicate" : "conflict",
        claim: existing,
      };
    }
    const claim = { key: normalizedKey, fingerprint, runId };
    this.claims.set(normalizedKey, claim);
    while (this.claims.size > this.maxClaims) {
      const oldest = this.claims.keys().next().value;
      if (oldest === undefined) break;
      this.claims.delete(oldest);
    }
    return { kind: "accepted", claim };
  }

  public clear(): void {
    this.claims.clear();
  }

  public get size(): number {
    return this.claims.size;
  }
}

/** Hash a validated command without retaining potentially large attachment data. */
export const fingerprintCommand = (command: unknown): string =>
  createHash("sha256").update(JSON.stringify(command)).digest("hex");

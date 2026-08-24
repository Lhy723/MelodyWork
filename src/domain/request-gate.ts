/**
 * Identifies the latest request in a component so stale async results can be
 * ignored without requiring every transport to support cancellation.
 */
export class RequestGate {
  private sequence = 0;

  begin(): number {
    this.sequence += 1;
    return this.sequence;
  }

  invalidate(): void {
    this.sequence += 1;
  }

  isCurrent(token: number): boolean {
    return token === this.sequence;
  }
}

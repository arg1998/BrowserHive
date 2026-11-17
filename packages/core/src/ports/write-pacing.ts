/** @module ports/write-pacing — how the request guard asks whether a guarded write may go out now (strategy `pace-writes`, spec 13 §9.4): the budgets live in the app layer, the guard only holds or aborts. */

/** One write the request guard matched (`ruleId` = `<pack id>#<guard id>`). */
export interface WritePaceRequest {
  readonly templateId: string;
  readonly ruleId: string;
}

/** The pacer's answer. */
export type WritePaceVerdict =
  /** Not paced (no `pace-writes`, not a write guard, no pace rule) or within budget. */
  | { readonly kind: 'pass' }
  /**
   * Over budget, the next token at most 60 s away: wait `holdMs` (jitter included), then go on to
   * the guard's action. Its token is reserved; `release()` gives it back when the write never went
   * out (the request went away while held).
   */
  | { readonly kind: 'hold'; readonly holdMs: number; release(): void }
  /** Over budget for longer: abort it (`paced`). */
  | { readonly kind: 'refuse'; readonly retryAfterMs: number };

/** Decides every guarded write of every template host. Never throws (a template or sites read that fails counts as no ramp). */
export interface WritePacing {
  pace(request: WritePaceRequest): Promise<WritePaceVerdict>;
}

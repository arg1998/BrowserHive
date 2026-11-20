/** @module ports/persistence/template-refusals — `template_refusals` (deferred D60): the agents a template's access rules refused, one aggregated row per (template, principal, harness, declared name, kind), bounded per template, deleted with the template. */

/** What the refused agent did (`template_refusals.kind`). */
export const TEMPLATE_REFUSAL_KINDS = ['list', 'launch'] as const;
/** Element of {@link TEMPLATE_REFUSAL_KINDS}. */
export type TemplateRefusalKind = (typeof TEMPLATE_REFUSAL_KINDS)[number];

/** Which part of the access rule refused (`template_refusals.reason`, the gate's own codes). */
export const TEMPLATE_REFUSAL_REASONS = ['principal_not_allowed', 'harness_not_allowed'] as const;
/** Element of {@link TEMPLATE_REFUSAL_REASONS}. */
export type TemplateRefusalReason = (typeof TEMPLATE_REFUSAL_REASONS)[number];

/** One refusal as it happens (before aggregation). */
export interface TemplateRefusalEvent {
  readonly templateId: string;
  readonly principal: string;
  /** The resolved harness slug; `unknown` when none. */
  readonly harness: string;
  /** The raw declared harness name; `null` when none was declared. */
  readonly harnessDeclared: string | null;
  readonly kind: TemplateRefusalKind;
  readonly reason: TemplateRefusalReason;
  readonly at: number;
}

/** One aggregated `template_refusals` row. */
export interface TemplateRefusalRecord extends Omit<TemplateRefusalEvent, 'at'> {
  /** Refusals counted since {@link firstAt}; at least 1. */
  readonly count: number;
  readonly firstAt: number;
  /** The newest refusal; its `reason` is the row's. */
  readonly lastAt: number;
}

/** Repository over `template_refusals`. */
export interface TemplateRefusalRepository {
  /**
   * Adds `delta` (one or more refusals of one row, coalesced by the caller) into its row: a new row
   * on first sight, else `count` grows, `last_at` moves forward and `reason` becomes the delta's.
   * Then keeps at most `maxRows` rows for the template, dropping the ones seen longest ago. Records
   * nothing for a template that no longer exists.
   */
  record(delta: TemplateRefusalRecord, maxRows: number): Promise<void>;
  /** One template's rows, newest `lastAt` first. */
  list(templateId: string): Promise<readonly TemplateRefusalRecord[]>;
}

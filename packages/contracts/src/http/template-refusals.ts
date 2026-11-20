/** @module contracts/http/template-refusals — the agents a template's access rules refused (spec 13 §6.1, §11.1; deferred D60): one aggregated row per client and kind, for operators only. The agent itself saw no template (an empty `list_templates`, `TEMPLATE_NOT_FOUND`). */
import { z } from 'zod';
import { EpochMs } from './common.ts';

/** What the refused agent did: listed templates (`list_templates`) or launched one by name. */
export const TemplateRefusalKind = z.enum(['list', 'launch']);
/** Union of {@link TemplateRefusalKind} members. */
export type TemplateRefusalKind = z.infer<typeof TemplateRefusalKind>;

/** Which part of the access rule refused: the principal list or the harness list (D-48). */
export const TemplateRefusalReason = z.enum(['principal_not_allowed', 'harness_not_allowed']);
/** Union of {@link TemplateRefusalReason} members. */
export type TemplateRefusalReason = z.infer<typeof TemplateRefusalReason>;

/** Rows kept per template; past it the row seen longest ago is dropped (a looping agent cannot flood storage). */
export const TEMPLATE_REFUSALS_MAX = 100;

/**
 * Harness names (slug and declared name) kept apart per principal and template; refusals under any
 * further name are counted together in one row whose `harness` is {@link REFUSAL_OTHER_HARNESSES}
 * (review #93 L2: an agent rotating its declared name cannot push other clients out of the log).
 */
export const REFUSAL_NAMES_PER_PRINCIPAL = 5;
/** The `harness` of the row that counts a principal's further harness names together. */
export const REFUSAL_OTHER_HARNESSES = '*';

/** One refused client of one kind, aggregated (`GET /templates/{template_id}/refusals`). */
export const TemplateRefusalRow = z.object({
  /** The caller's principal id (`local` without token auth). */
  principal: z.string(),
  /**
   * The resolved harness slug of the call (`unknown` when none was recognised), or `*`: refusals
   * under the principal's harness names past the first {@link REFUSAL_NAMES_PER_PRINCIPAL}.
   */
  harness: z.string(),
  /** The raw harness name the client declared, when it declared one (D-48). */
  harness_declared: z.string().nullable(),
  kind: TemplateRefusalKind,
  /** The reason of the newest refusal. */
  reason: TemplateRefusalReason,
  /** Refusals counted since `first_at`. */
  count: z.number().int().positive(),
  first_at: EpochMs,
  last_at: EpochMs,
});
/** One refused client. */
export type TemplateRefusalRow = z.infer<typeof TemplateRefusalRow>;

/** `GET /templates/{template_id}/refusals` body: newest `last_at` first, at most `max_rows`. */
export const TemplateRefusalsResponse = z.object({
  data: z.array(TemplateRefusalRow),
  max_rows: z.number().int().positive(),
});
/** `GET …/refusals` body. */
export type TemplateRefusalsResponse = z.infer<typeof TemplateRefusalsResponse>;

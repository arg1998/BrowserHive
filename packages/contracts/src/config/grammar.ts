/** @module contracts/config/grammar — grammar metadata shared by every config parser */
import { z } from 'zod';

/** Metadata key under which every parser stores its human-readable grammar. */
export const GRAMMAR_META_KEY = 'grammar';

/**
 * The grammar string of a parser (or of a key schema built from one), for error messages such as
 * `invalid value for --sessionLease: '2 hours'. Expected <grammar>.`
 *
 * @returns The grammar text, or `undefined` for schemas without one.
 */
export function grammarOf(schema: z.ZodType): string | undefined {
  const value = schema.meta()?.[GRAMMAR_META_KEY];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Record a grammar violation on `ctx` and return `z.NEVER` (the transform's escape hatch).
 *
 * @returns Never returns a value; typed `never` so callers can `return grammarFail(...)`.
 */
export function grammarFail(ctx: z.RefinementCtx, grammar: string, input: unknown): never {
  ctx.addIssue({
    code: 'custom',
    message: `Expected ${grammar}, got ${JSON.stringify(input)}.`,
    input,
  });
  return z.NEVER;
}

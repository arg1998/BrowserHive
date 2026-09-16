/** @module contracts/errors/spec — the shape of one error registry entry and the `defineError` helper */
import type { z } from 'zod';
import type { ErrorCategory } from '../enums/error-category.ts';
import type { Retryable } from '../enums/retryable.ts';

/** Process exit code a boot-category error maps to (spec 08 §7.3). */
export type BootExitCode = 1 | 3 | 64;

/**
 * One registry entry (D-07). `message` is the exact public message text (stable: clients may match on
 * it) with `{placeholder}` slots named after `details` keys; `title` is short and stable.
 * `httpStatus` is `500` for codes that are never projected over HTTP (boot, audit, warning).
 */
export interface ErrorSpecShape<C extends string = string, D extends z.ZodType = z.ZodType> {
  /** The stable code; equals the registry key. */
  readonly code: C;
  /** HTTP status used by the problem+json projection. */
  readonly httpStatus: number;
  /** Registry category (`domain|boot|auth|transport|audit|warning`). */
  readonly category: ErrorCategory;
  /** Default retry guidance; an `AppError` instance may override it. */
  readonly retryable: Retryable;
  /** Short, stable title (problem+json `title`, WS error frame `title`). */
  readonly title: string;
  /** Public message template; `{name}` slots are substituted from `details` (see `renderMessage`). */
  readonly message: string;
  /** One-sentence next step for the agent or operator. */
  readonly hint?: string;
  /** Schema of the structured `details` carried by the error. */
  readonly details: D;
  /** Whether the code is rendered into `docs/errors.md`. */
  readonly docs: boolean;
  /** Docs prose: what causes the error. */
  readonly cause?: string;
  /** Docs prose: how to resolve it. */
  readonly resolution?: string;
  /** Boot codes only: the process exit code the CLI uses. */
  readonly exitCode?: BootExitCode;
}

/**
 * Identity helper that keeps the literal `code` and the concrete `details` schema type of an entry.
 *
 * @returns The entry unchanged, precisely typed.
 */
export function defineError<const C extends string, D extends z.ZodType>(
  spec: ErrorSpecShape<C, D>,
): ErrorSpecShape<C, D> {
  return spec;
}

/**
 * Substitute `{name}` slots in a message template. Missing slots are left verbatim so a rendering
 * bug is visible rather than silent; `extra` supplies derived labels that are not details keys.
 *
 * @returns The rendered public message.
 */
export function renderMessage(
  template: string,
  details: Readonly<Record<string, unknown>>,
  extra: Readonly<Record<string, string>> = {},
): string {
  return template.replace(/\{([a-z_]+)\}/g, (slot, name: string) => {
    const fromExtra = extra[name];
    if (fromExtra !== undefined) return fromExtra;
    const value = details[name];
    if (value === undefined) return slot;
    return typeof value === 'string' ? value : JSON.stringify(value);
  });
}

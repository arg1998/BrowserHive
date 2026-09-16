/** @module infra/browsers/evaluate — main-world `page.evaluate` across Patchright (isolated by default) and stock Playwright (spec 11 §2.1). */

import type { Frame, Page } from 'playwright';

/**
 * Patchright's `evaluate` takes a **fourth** positional `isolatedContext` (after Playwright 1.63's
 * `options` bag); `false` keeps main-world semantics. Stock Playwright 1.63 asserts at most three
 * arguments and rejects a non-object third one, so the extra argument cannot be passed
 * blindly — the caller must know which driver launched the session (`capabilities.isolatedEvaluate`).
 */
type DriverEvaluate = <R, Arg>(
  pageFunction: (arg: Arg) => R | Promise<R>,
  arg: Arg,
  options?: { exposeFunctions?: boolean },
  isolatedContext?: boolean,
) => Promise<R>;

/** The evaluation surface: a `Page` or a `Frame`. */
export type Evaluable = Page | Frame;

/**
 * Evaluate `pageFunction` in the page's **main world** regardless of driver: under Patchright the
 * fourth positional `isolatedContext: false` is passed; under stock Playwright (which already runs
 * in the main world) the plain two-argument form is used.
 *
 * @param isolatedEvaluate `SessionHandle.capabilities.isolatedEvaluate` for the session that owns `target`.
 */
export function evaluateMainWorld<R, Arg = undefined>(
  target: Evaluable,
  isolatedEvaluate: boolean,
  pageFunction: (arg: Arg) => R | Promise<R>,
  arg?: Arg,
): Promise<R> {
  // Same method object, widened to the driver-specific signature; the cast is on the method, not on
  // a payload (Playwright's own overloads cannot express the Patchright extension).
  const driver = target as unknown as { evaluate: DriverEvaluate };
  const value = arg as Arg;
  return isolatedEvaluate
    ? driver.evaluate(pageFunction, value, undefined, false)
    : driver.evaluate(pageFunction, value);
}

/** @module infra/browsers/evaluate — main-world `page.evaluate` on Patchright, which isolates `evaluate` by default (spec 11 §2.1, D-65). */

import type { Frame, Page } from 'patchright';

/**
 * Patchright's `evaluate` takes a **fourth** positional `isolatedContext` (after Playwright 1.63's
 * `options` bag); `false` keeps main-world semantics. Every Chromium host reports
 * `capabilities.isolatedEvaluate: true` (Patchright is the only driver, D-65); the plain form is for
 * an engine without isolated evaluation (stock Playwright asserts at most three arguments).
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
 * Evaluate `pageFunction` in the page's **main world**: with `isolatedEvaluate` (Patchright) the
 * fourth positional `isolatedContext: false` is passed; otherwise the plain two-argument form.
 *
 * @param isolatedEvaluate `BrowserHost.capabilities.isolatedEvaluate` of the host serving the session that owns `target`.
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

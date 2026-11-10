/** @module test/fixtures/depcruise/browserhive — reads a driver's `package.json`, which no rule forbids. */
import { createRequire } from 'node:module';

/** The version of the optional driver, as `wire-observers.ts` reads it. */
export function version(): unknown {
  return createRequire(import.meta.url)('patchright/package.json');
}

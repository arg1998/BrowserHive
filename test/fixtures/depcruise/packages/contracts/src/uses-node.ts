/** @module test/fixtures/depcruise/contracts — breaks `contracts-platform-neutral`. */
import { readFileSync } from 'node:fs';

/** Uses the import so the fixture type-checks. */
export const read = readFileSync;

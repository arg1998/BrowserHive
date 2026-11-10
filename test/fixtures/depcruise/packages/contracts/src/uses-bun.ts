/** @module test/fixtures/depcruise/contracts-bun — breaks the contracts rules with Bun's own modules. */

import type { Database } from 'bun:sqlite';
import type { BunFile } from 'bun';

/** Uses the imports so the fixture type-checks. */
export type BunTypes = [BunFile, Database];

/** @module infra/persistence/migrations/0004-session-browser — schema v4: what each session's browser ran with, recorded at launch: the sandbox verdict and the real browser version (spec 03 §7, D-31). */

import type { Migration } from './migration.ts';

const sql = `
ALTER TABLE sessions ADD COLUMN sandboxed INTEGER CHECK (sandboxed IN (0,1));
ALTER TABLE sessions ADD COLUMN browser_version TEXT;
`;

/**
 * Schema v4. `compatible`: purely additive, so a v3 reader still understands every table. Existing
 * sessions keep NULL in both columns, which reads "not recorded": nothing is backfilled, because under
 * `sandbox=auto` the verdict depended on the browser and the host at the time.
 */
export const sessionBrowser: Migration = {
  version: 4,
  name: 'session-browser',
  compatible: true,
  sql,
};

/** @module infra/persistence/migrations/0011-template-clipboard — schema v11: the per-template "Deny clipboard writes" switch (spec 13 §2.1, §13 "The operator's desktop"; deferred D18). */

import type { Migration } from './migration.ts';

/*
 * One column, default off: every existing template keeps today's behaviour. The CHECK list is a
 * literal frozen in this file (spec 13 §9.9).
 */
const sql = `
ALTER TABLE templates ADD COLUMN deny_clipboard_writes INTEGER NOT NULL DEFAULT 0 CHECK (deny_clipboard_writes IN (0,1));
`;

/**
 * Schema v11. `compatible`: one column with a default, so a v10 reader still understands every
 * table and its inserts get the default. A v10 binary ignores the switch (it only narrows what a
 * page may do), so `meta.min_reader_version` stays 10.
 */
export const templateClipboard: Migration = {
  version: 11,
  name: 'template-clipboard',
  compatible: true,
  sql,
};

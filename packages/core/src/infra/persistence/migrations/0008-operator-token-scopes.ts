/** @module infra/persistence/migrations/0008-operator-token-scopes — schema v8: operator API tokens issued without `scopes` store `[]`, "the operator's full set" (spec 03 §3.5). */

import type { Migration } from './migration.ts';

/*
 * Operator API tokens are now limited to their credential's scopes (spec 03 §3.5). A token issued
 * without `scopes` used to store the full operator list of the release that issued it, so a token
 * from 0.1.x lacks `channels:read` and `channels:write`, which 0.2.0 added. Such tokens were
 * issued as "every scope" and must keep meaning that, so they are rewritten to `[]`, which
 * `principalFromRecord` expands to the operator's full set (and keeps expanding as scopes are
 * added). Two lists are recognised, both exactly as `JSON.stringify` wrote them in registry order:
 *
 * - the 0.2.x full list (19 scopes): every scope, whenever it was issued;
 * - the 0.1.x full list (17 scopes), only for tokens created before the first 0.2.0 migration
 *   (v3) was applied to this database. On 0.1.x that list was every scope; from 0.2.0 on it is a
 *   deliberate choice to leave out the channels, so it stays as it is.
 *
 * Agent tokens, operator tokens with any other list, and other credentials are not touched.
 */
const FULL_V02 =
  '["sessions:read","sessions:write","sessions:takeover","attention:read","attention:resolve","vault:read","vault:write","vault:confirm","blocklist:read","blocklist:write","system:read","system:write","logs:read","notifications:read","notifications:write","channels:read","channels:write","preferences:write","mcp:tools"]';
const FULL_V01 =
  '["sessions:read","sessions:write","sessions:takeover","attention:read","attention:resolve","vault:read","vault:write","vault:confirm","blocklist:read","blocklist:write","system:read","system:write","logs:read","notifications:read","notifications:write","preferences:write","mcp:tools"]';

const sql = `
UPDATE credentials SET scopes_json = '[]'
WHERE kind = 'api_token'
  AND principal_id IN (SELECT principal_id FROM principals WHERE kind = 'operator')
  AND (
    scopes_json = '${FULL_V02}'
    OR (
      scopes_json = '${FULL_V01}'
      AND created_at < (SELECT applied_at FROM schema_migrations WHERE version = 3)
    )
  );
`;

/**
 * Schema v8. `compatible`: data only, and an older reader also expands `[]` to the kind's full
 * set, so a v7 binary reads every rewritten token as it did before.
 */
export const operatorTokenScopes: Migration = {
  version: 8,
  name: 'operator-token-scopes',
  compatible: true,
  sql,
};

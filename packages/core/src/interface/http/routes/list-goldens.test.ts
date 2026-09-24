/** @module interface/http/routes/list-goldens.test — response goldens of list routes over the seeded dataset with a fixed clock and ids (`UPDATE_GOLDENS=1` blesses). */

import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLOSED_ID } from '../../../../test/helpers/http-fixtures.ts';
import { createHttpKit } from '../../../../test/helpers/http-kit.ts';

const GOLDEN_DIR = join(import.meta.dir, '..', '..', '..', '..', 'test', 'goldens', 'http');
const UPDATE = process.env['UPDATE_GOLDENS'] === '1';

const LISTS: readonly (readonly [string, string])[] = [
  ['listSessions', '/api/v1/sessions?archived=include'],
  ['listSessionToolCalls', `/api/v1/sessions/${CLOSED_ID}/tool-calls`],
  ['listSessionPages', `/api/v1/sessions/${CLOSED_ID}/pages`],
  ['listSessionBlocked', `/api/v1/sessions/${CLOSED_ID}/blocked`],
  ['listSessionScreenshots', `/api/v1/sessions/${CLOSED_ID}/screenshots`],
  ['listSessionVaultAccess', `/api/v1/sessions/${CLOSED_ID}/vault-access`],
  ['getSessionTimeline', `/api/v1/sessions/${CLOSED_ID}/timeline`],
  ['listToolCalls', '/api/v1/tool-calls?total=true'],
  ['listPages', '/api/v1/pages'],
  ['listBlockedAttempts', '/api/v1/blocklist/attempts'],
  ['listVaultBindings', '/api/v1/vault/bindings'],
  ['listVaultLog', '/api/v1/vault/log'],
  ['listAttention', '/api/v1/attention'],
  ['listNotifications', '/api/v1/notifications'],
  ['listSystemEvents', '/api/v1/system/events'],
  ['listLogs', '/api/v1/logs'],
  ['listMcpConnections', '/api/v1/system/mcp/connections'],
  ['getHarnessMetrics', '/api/v1/metrics/harnesses?since=0'],
];

describe('list response goldens', () => {
  for (const [operationId, path] of LISTS) {
    it(operationId, async () => {
      const kit = await createHttpKit();
      const cookie = await kit.login();
      const response = await kit.request('GET', path, { cookie });
      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      const file = join(GOLDEN_DIR, `${operationId}.json`);
      if (UPDATE || !existsSync(file)) {
        mkdirSync(GOLDEN_DIR, { recursive: true });
        writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
      }
      expect(body).toEqual(JSON.parse(readFileSync(file, 'utf8')));
    });
  }
});

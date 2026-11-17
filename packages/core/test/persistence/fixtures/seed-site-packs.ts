/** @module test/persistence/fixtures/seed-site-packs — the schema v10 rows of the fixture database (spec 13 §9.9): a `security_intercept` request with its template, one pack's approval state, one candidate and one guard hit. */

import { emptySitePackState } from '../../../src/ports/persistence/site-packs.ts';
import type { Repositories } from '../../../src/ports/persistence/unit-of-work.ts';
import { TEMPLATE_ID } from '../helpers.ts';

/** Seeds the v10 rows; the template session `jobs-t1t2t3t4` must exist. */
export async function seedSitePacks(r: Repositories, at: number): Promise<void> {
  await r.operatorRequests.insert({
    requestId: 'a-fixture00002',
    kind: 'security_intercept',
    sessionId: 'jobs-t1t2t3t4',
    owner: 'local',
    reason: 'LinkedIn security check',
    mode: 'takeover',
    entryName: null,
    tool: 'navigate',
    toolEventId: null,
    pageUrl: 'https://www.linkedin.com/checkpoint/challenge',
    options: { reason: 'challenge', site: 'linkedin', kind: 'cloudflare', action: 'attention' },
    idempotencyKey: null,
    createdAt: at + 5_000,
    deadlineAt: at + 1_805_000,
    templateId: TEMPLATE_ID,
  });
  await r.sitePackState.put({
    ...emptySitePackState('linkedin', at),
    approvedVersion: 1,
    approvedSha256: 'b'.repeat(64),
    approvedSource: 'bundled',
    approvedProvenance: { kind: 'bundled', release: '0.4.0' },
    approvedDomains: ['linkedin.com'],
    approvedBy: 'local',
    approvedAt: at,
  });
  await r.sitePackChanges.insert({
    seq: 0,
    eventId: 'e-spc-1',
    packId: 'linkedin',
    fromVersion: null,
    toVersion: 1,
    toSha256: 'b'.repeat(64),
    source: 'bundled',
    classification: 'new_pack',
    newDomains: ['linkedin.com'],
    notes: null,
    diff: [],
    decision: 'approved',
    decidedBy: 'local',
    createdAt: at,
    decidedAt: at,
  });
  await r.siteGuardHits.insert({
    eventId: 'e-sgh-1',
    sessionId: 'jobs-t1t2t3t4',
    templateId: TEMPLATE_ID,
    packId: 'linkedin',
    guardId: 'logout',
    guardKind: 'logout',
    action: 'block',
    outcome: null,
    decidedBy: null,
    source: 'request',
    method: 'GET',
    url: 'https://www.linkedin.com/m/logout/',
    requestId: null,
    tool: 'navigate',
    ts: at + 6_000,
  });
}

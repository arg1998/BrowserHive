/** @module test/helpers/http-fixtures — the seeded dataset behind the HTTP route suites and list goldens (fixed ids and clock). */

import type { SystemInfo } from '@browserhive/contracts/http';
import type { z } from 'zod';
import type { SessionDirLayout } from '../../src/app/sessions/profile-dir.ts';
import type { SessionRecord } from '../../src/ports/persistence/records.ts';
import { type FakeFiles, NOW } from './http-fakes.ts';
import type { InMemoryRepositories } from './in-memory-repos.ts';
import type { createVaultRepos } from './in-memory-vault-repos.ts';

/** Closed, stored session. */
export const CLOSED_ID = 'shop-0000000a';
/** Second stored session (archived). */
export const ARCHIVED_ID = 'docs-0000000b';
/** Tool call event ids. */
export const EVENT_OK = 'e-00000000000000000000000001';
export const EVENT_ERR = 'e-00000000000000000000000002';
/** Page event id. */
export const EVENT_PAGE = 'e-00000000000000000000000003';
/** Blocked request event id. */
export const EVENT_BLOCKED = 'e-00000000000000000000000004';
/** Vault access event id. */
export const EVENT_VAULT = 'e-00000000000000000000000005';

/** A stored session row. */
export function sessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: CLOSED_ID,
    slug: 'shop',
    owner: 'agent-1',
    tenantId: null,
    connectionId: null,
    engine: 'chromium',
    channel: 'chromium',
    headless: true,
    incognito: false,
    persistenceMode: 'memory',
    disableEvaluate: false,
    vaultEnabled: true,
    stealth: false,
    fingerprint: false,
    humanize: false,
    identity: null,
    proxyLabel: null,
    state: 'closed',
    createdAt: NOW - 50_000,
    launchedAt: NOW - 49_000,
    lastActivityAt: NOW - 10_000,
    leaseExpiresAt: NOW + 7_200_000,
    leasePausedAt: null,
    closedAt: NOW - 5_000,
    closedReason: 'user',
    archivedAt: null,
    lastUrl: 'https://example.com/',
    launchMs: 1000,
    config: {},
    harness: null,
    ...overrides,
  };
}

/** Seeds sessions, tool calls, a screenshot, a page, a blocked request, a vault access and notifications. */
export async function seedDataset(
  repos: InMemoryRepositories,
  vault: ReturnType<typeof createVaultRepos>,
  files: FakeFiles,
  dirs: SessionDirLayout,
): Promise<void> {
  await repos.mcpConnections.insert({
    connectionId: 'c-seed000001',
    principalId: 'local',
    transport: 'http',
    mcpSessionId: 'm-seed000000000001',
    clientName: 'claude-code',
    clientVersion: '2.1.281',
    clientTitle: null,
    protocolVersion: '2025-06-18',
    capabilities: { roots: { listChanged: true } },
    workspace: 'checkout',
    agentName: 'checkout',
    model: 'claude-opus-5',
    modelSource: 'header',
    harness: 'claude-code',
    harnessSource: 'client_info',
    conflicts: [],
    meta: { team: 'growth' },
    ip: '127.0.0.1',
    userAgent: 'claude-code/2.1.281 (cli)',
    connectedAt: NOW - 120_000,
    lastSeenAt: NOW - 5_000,
    closedAt: null,
  });
  await repos.mcpConnections.insert({
    connectionId: 'c-seed000002',
    principalId: 'local',
    transport: 'stdio',
    mcpSessionId: null,
    clientName: 'mcp',
    clientVersion: '0.1.0',
    clientTitle: null,
    protocolVersion: '2025-06-18',
    capabilities: {},
    workspace: null,
    agentName: null,
    model: null,
    modelSource: null,
    harness: 'unknown',
    harnessSource: 'none',
    conflicts: [],
    meta: {},
    ip: null,
    userAgent: null,
    connectedAt: NOW - 600_000,
    lastSeenAt: NOW - 500_000,
    closedAt: NOW - 400_000,
  });
  await repos.sessions.insert(
    sessionRecord({ connectionId: 'c-seed000001', harness: 'claude-code' }),
  );
  await repos.sessions.insert(
    sessionRecord({
      sessionId: ARCHIVED_ID,
      slug: 'docs',
      archivedAt: NOW - 1000,
      createdAt: NOW - 90_000,
    }),
  );
  const call = {
    sessionId: CLOSED_ID,
    connectionId: null,
    tabId: 't-000001',
    args: { url: 'https://example.com/' },
    resultText: 'ok',
    resultSizeBytes: 2,
    durationMs: 10,
    traceId: null,
    spanId: null,
  };
  await repos.toolCalls.insert({
    ...call,
    eventId: EVENT_OK,
    tool: 'navigate',
    ok: true,
    errorCode: null,
    errorMessage: null,
    ts: NOW - 30_000,
    seq: 1,
  });
  await repos.toolCalls.insert({
    ...call,
    eventId: EVENT_ERR,
    tool: 'click',
    ok: false,
    errorCode: 'ELEMENT_NOT_FOUND',
    errorMessage: 'no element',
    ts: NOW - 20_000,
    seq: 2,
  });
  const shotPath = `${dirs.forSession(CLOSED_ID).screenshots}/${EVENT_OK}.png`;
  await repos.screenshots.insert({
    eventId: EVENT_OK,
    sessionId: CLOSED_ID,
    path: shotPath,
    kind: 'tool',
    contentType: 'image/png',
    width: 10,
    height: 10,
    sizeBytes: 4,
    ts: NOW - 30_000,
  });
  files.files.set(shotPath, new Uint8Array([137, 80, 78, 71]));
  files.files.set(
    dirs.forSession(CLOSED_ID).traceZip,
    new Uint8Array(Array.from({ length: 100 }, (_, i) => i)),
  );
  await repos.pages.insert({
    eventId: EVENT_PAGE,
    sessionId: CLOSED_ID,
    tabId: 't-000001',
    url: 'https://example.com/',
    title: 'Example',
    domain: 'example.com',
    category: 'public',
    ts: NOW - 29_000,
  });
  await repos.blocklistAudit.insert({
    eventId: EVENT_BLOCKED,
    sessionId: CLOSED_ID,
    toolEventId: null,
    url: 'https://evil.example/',
    domain: 'evil.example',
    pattern: 'evil.example',
    source: 'request',
    tool: null,
    ts: NOW - 25_000,
  });
  await vault.audit.insert({
    eventId: EVENT_VAULT,
    sessionId: CLOSED_ID,
    toolEventId: null,
    entryName: 'work.github',
    handle: 'work.github',
    result: 'success',
    reason: null,
    evaluateEnabled: false,
    pageUrl: 'https://github.com/login',
    originCheck: 'pass',
    principalId: 'agent-1',
    details: null,
    ts: NOW - 24_000,
  });
  await repos.notifications.insert({
    notificationId: 'n-000000000001',
    principalId: null,
    type: 'error',
    title: 'closed-run · 1 tool error',
    body: 'click · ELEMENT_NOT_FOUND (10 ms)',
    sessionId: CLOSED_ID,
    target: `/sessions/${CLOSED_ID}?kinds=tool&errors_only=1`,
    sourceEventId: EVENT_ERR,
    createdAt: NOW - 20_000,
    updatedAt: NOW - 20_000,
    count: 1,
    groupKey: `tool-errors:${CLOSED_ID}`,
    readAt: null,
    dismissedAt: null,
  });
  await repos.systemEvents.record({
    eventId: 'e-00000000000000000000000009',
    code: 'BLOCKLIST_RELOAD_FAILED',
    severity: 'warn',
    message: 'reload failed',
    details: null,
    at: NOW - 1000,
  });
  await vault.bindings.upsert({
    handle: 'work.github',
    tenantId: null,
    title: 'GitHub',
    itemName: 'GitHub',
    itemId: 'i1',
    groupId: null,
    allowedOrigins: ['https://github.com'],
    authorizedPrincipals: [],
    authorizedSessionSlugs: ['shop'],
    allowAllSessions: false,
    redactUsername: false,
    requireNoEvaluate: false,
    dashboardConfirm: false,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

/** A valid `/system` payload (the system status service is not under test here). */
export const SYSTEM_INFO: z.input<typeof SystemInfo> = {
  version: '0.1.0',
  runtime: {
    bun: '1.4.0',
    sqlite: '3.46.0',
    playwright: '1.63.0',
    patchright: null,
    chromium: null,
  },
  data_dir: '/data',
  mcp: { connections: 0 },
  transport: 'http',
  uptime_ms: 60_000,
  started_at: NOW - 60_000,
  host: '127.0.0.1',
  port: 9876,
  admin: true,
  auth_mode: 'token',
  capacity: { live: 0, max: 8, max_source: 'derived' },
  open_attention: 0,
  active_screencasts: 0,
  realtime: { connections: 0 },
  allow_evaluate: true,
  persistence_mode: 'memory',
  stealth: {
    profile: 'standard',
    driver: 'playwright',
    fingerprint: true,
    humanize: false,
    captcha: 'attention',
  },
  vault: { enabled: true, backend: 'bitwarden' },
  blocklist: { configured: true, path: '/data/blocklist.txt', patterns: 1 },
  retention: {
    days: 7,
    bytes: 1_073_741_824,
    last_run_at: null,
    last_result: null,
    next_run_at: null,
    pruned_rows: 0,
    artifacts_pending: 0,
  },
  storage: {
    db_bytes: 4096,
    schema_version: 1,
    min_reader_version: 1,
    migrations: [],
    dropped_writes_total: 0,
    write_queue_depth: 0,
    last_backup_at: null,
    backups_count: 0,
  },
  otel: { enabled: false, endpoint: null, protocol: null },
  degradations: [],
  now: NOW,
};

/** @module test/persistence/helpers — fake clock/logger, temp dirs and record builders for persistence suites. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Clock } from '../../src/ports/clock.ts';
import type { LogFields, Logger, LogLevel } from '../../src/ports/logger.ts';
import type {
  BlockedRequestRecord,
  PageRecord,
  ScreenshotRecord,
  SessionRecord,
  ToolCallRecord,
  VaultAccessRecord,
} from '../../src/ports/persistence/records.ts';

/** A settable clock; `sleep` resolves immediately after advancing. */
export class FakeClock implements Clock {
  #now: number;
  constructor(start = 1_700_000_000_000) {
    this.#now = start;
  }
  now(): number {
    return this.#now;
  }
  set(ms: number): void {
    this.#now = ms;
  }
  advance(ms: number): void {
    this.#now += ms;
  }
  sleep(ms: number): Promise<void> {
    this.#now += ms;
    return Promise.resolve();
  }
}

/** Collects records in memory. */
export class FakeLogger implements Logger {
  readonly records: { level: LogLevel; msg: string; fields?: LogFields }[] = [];
  child(): Logger {
    return this;
  }
  isLevelEnabled(): boolean {
    return true;
  }
  error(msg: string, fields?: LogFields): void {
    this.records.push({ level: 'error', msg, ...(fields !== undefined && { fields }) });
  }
  warn(msg: string, fields?: LogFields): void {
    this.records.push({ level: 'warn', msg, ...(fields !== undefined && { fields }) });
  }
  info(msg: string, fields?: LogFields): void {
    this.records.push({ level: 'info', msg, ...(fields !== undefined && { fields }) });
  }
  debug(msg: string, fields?: LogFields): void {
    this.records.push({ level: 'debug', msg, ...(fields !== undefined && { fields }) });
  }
  trace(msg: string, fields?: LogFields): void {
    this.records.push({ level: 'trace', msg, ...(fields !== undefined && { fields }) });
  }
}

/** Creates a temp directory removed by the returned disposer. */
export function tempDir(prefix = 'bh-persist-'): { path: string; dispose(): void } {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return { path, dispose: () => rmSync(path, { recursive: true, force: true }) };
}

/** A session record with sensible defaults. */
export function sessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  const id = overrides.sessionId ?? 'shop-a1b2c3d4';
  return {
    sessionId: id,
    slug: id.split('-')[0] ?? 'shop',
    owner: 'local',
    tenantId: null,
    connectionId: null,
    engine: 'chromium',
    channel: 'chromium',
    headless: true,
    incognito: false,
    persistenceMode: 'memory',
    disableEvaluate: false,
    vaultEnabled: true,
    stealth: true,
    fingerprint: true,
    humanize: false,
    identity: null,
    proxyLabel: null,
    state: 'live',
    createdAt: 1_700_000_000_000,
    launchedAt: 1_700_000_000_500,
    lastActivityAt: 1_700_000_000_500,
    leaseExpiresAt: 1_700_000_600_000,
    leasePausedAt: null,
    closedAt: null,
    closedReason: null,
    archivedAt: null,
    lastUrl: null,
    launchMs: 500,
    config: { channel: 'chromium', headless: true },
    ...overrides,
  };
}

/** A tool call record with sensible defaults. */
export function toolCallRecord(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    eventId: 'e-01HZZZZZZZZZZZZZZZZZZZZZZZ',
    sessionId: 'shop-a1b2c3d4',
    connectionId: null,
    tool: 'navigate',
    tabId: 't-abc123',
    args: { url: 'https://example.com' },
    ok: true,
    errorCode: null,
    errorMessage: null,
    resultText: '{"url":"https://example.com"}',
    resultSizeBytes: 29,
    durationMs: 120,
    ts: 1_700_000_001_000,
    traceId: null,
    spanId: null,
    seq: 1,
    ...overrides,
  };
}

/** A page record with sensible defaults. */
export function pageRecord(overrides: Partial<PageRecord> = {}): PageRecord {
  return {
    eventId: 'e-page-000001',
    sessionId: 'shop-a1b2c3d4',
    tabId: 't-abc123',
    url: 'https://example.com/',
    title: null,
    domain: 'example.com',
    category: 'public',
    ts: 1_700_000_001_000,
    ...overrides,
  };
}

/** A screenshot record with sensible defaults. */
export function screenshotRecord(overrides: Partial<ScreenshotRecord> = {}): ScreenshotRecord {
  return {
    eventId: 'e-01HZZZZZZZZZZZZZZZZZZZZZZZ',
    sessionId: 'shop-a1b2c3d4',
    path: 'sessions/shop-a1b2c3d4/screenshots/e-01HZZZZZZZZZZZZZZZZZZZZZZZ.jpg',
    kind: 'trace',
    contentType: 'image/jpeg',
    width: 1280,
    height: 720,
    sizeBytes: 12_345,
    ts: 1_700_000_001_000,
    ...overrides,
  };
}

/** A vault access record with sensible defaults. */
export function vaultAccessRecord(overrides: Partial<VaultAccessRecord> = {}): VaultAccessRecord {
  return {
    eventId: 'e-vault-000001',
    sessionId: 'shop-a1b2c3d4',
    toolEventId: null,
    entryName: 'github',
    handle: 'github',
    result: 'success',
    reason: null,
    evaluateEnabled: false,
    pageUrl: 'https://github.com/login',
    originCheck: 'pass',
    principalId: 'local',
    details: null,
    ts: 1_700_000_002_000,
    ...overrides,
  };
}

/** A blocked request record with sensible defaults. */
export function blockedRequestRecord(
  overrides: Partial<BlockedRequestRecord> = {},
): BlockedRequestRecord {
  return {
    eventId: 'e-blocked-000001',
    sessionId: 'shop-a1b2c3d4',
    toolEventId: null,
    url: 'https://ads.example.net/pixel',
    domain: 'ads.example.net',
    pattern: '*.example.net',
    source: 'request',
    tool: null,
    ts: 1_700_000_003_000,
    ...overrides,
  };
}

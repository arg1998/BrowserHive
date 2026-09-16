/** @module features/logs/log-filters.test — client filter mirrors the server (module root prefix, q over the record JSON, inclusive until), runtime level spec parse/format, level control validation, safe level lookups */

import { describe, expect, it } from 'bun:test';
import { logRecord } from '../../../test/fixtures/ops.ts';
import {
  httpSummary,
  inlineFields,
  isDashboardTraffic,
  levelEntry,
  traceUrl,
} from './log-fields.ts';
import {
  draftSpec,
  formatLogLevelSpec,
  logsFilterKey,
  MODULE_HINT,
  matchesLogFilters,
  moduleRoot,
  parseLogLevelSpec,
  readLogLevel,
} from './log-filters.ts';
import { logsSearch } from './search.ts';

describe('matchesLogFilters', () => {
  it('matches levels, search text over fields, and module roots like the server', () => {
    const search = logsSearch.parse({ level: 'warn,error', q: 'lease', module: 'sessions' });
    expect(matchesLogFilters(logRecord(1, { level: 'warn', msg: 'lease x' }), search)).toBe(true);
    expect(
      matchesLogFilters(
        logRecord(1, { level: 'warn', msg: 'x', module: 'sessions.lifecycle', slug: 'lease-1' }),
        search,
      ),
    ).toBe(true);
    expect(matchesLogFilters(logRecord(1, { level: 'info', msg: 'lease x' }), search)).toBe(false);
    expect(
      matchesLogFilters(logRecord(1, { level: 'warn', msg: 'lease', module: 'sessionsx' }), search),
    ).toBe(false);
    expect(moduleRoot('http.access')).toBe('http');
  });

  it('keys filter sets independently of param order', () => {
    expect(logsFilterKey(logsSearch.parse({ q: 'a', level: 'warn' }))).toBe(
      logsFilterKey(logsSearch.parse({ level: 'warn', q: 'a' })),
    );
  });
});

describe('log level spec', () => {
  it('parses, formats and reads the canonical config value', () => {
    expect(parseLogLevelSpec('info,sessions=debug')).toEqual({
      root: 'info',
      overrides: [{ module: 'sessions', level: 'debug' }],
    });
    expect(parseLogLevelSpec('loud')).toBeUndefined();
    expect(parseLogLevelSpec('info,Sessions=debug')).toBeUndefined();
    expect(
      formatLogLevelSpec({ root: 'warn', overrides: [{ module: 'http', level: 'trace' }] }),
    ).toBe('warn,http=trace');
    expect(readLogLevel({ root: 'info', modules: { sessions: 'debug', bad: 'nope' } })).toEqual({
      root: 'info',
      overrides: [{ module: 'sessions', level: 'debug' }],
    });
  });

  it('validates the level control draft', () => {
    expect(draftSpec({ root: 'info', overrides: [{ module: ' http ', level: 'debug' }] })).toEqual({
      spec: 'info,http=debug',
    });
    expect(
      draftSpec({ root: 'info', overrides: [{ module: 'http.access', level: 'debug' }] }),
    ).toEqual({
      error: MODULE_HINT,
    });
    expect(
      draftSpec({
        root: 'info',
        overrides: [
          { module: 'http', level: 'debug' },
          { module: 'http', level: 'warn' },
        ],
      }),
    ).toEqual({ error: 'http is listed twice.' });
  });
});

describe('log fields', () => {
  it('summarises access records, orders inline fields and never throws on unknown levels', () => {
    const access = logRecord(1, {
      module: 'http.access',
      method: 'POST',
      route_pattern: 'login',
      status: 200,
      duration_ms: 12,
      tool: 'navigate',
    });
    expect(httpSummary(access)).toEqual({
      method: 'POST',
      target: 'login',
      status: 200,
      durationMs: 12,
    });
    expect(inlineFields(access).map((f) => f.key)).toEqual(['tool']);
    expect(levelEntry('fatal')).toEqual({ label: 'fatal', tone: 'neutral' });
    expect(traceUrl('https://apm/{trace_id}', 'a b')).toBe('https://apm/a%20b');
    expect(traceUrl(undefined, 'x')).toBeNull();
  });
});

describe('isDashboardTraffic', () => {
  const access = (patch: Record<string, unknown>) =>
    logRecord(1, {
      module: 'http.access',
      msg: 'request completed',
      method: 'GET',
      route_pattern: 'getMe',
      status: 200,
      ...patch,
    });
  it('classes successful REST and socket GETs and socket lifecycle lines as dashboard traffic', () => {
    expect(isDashboardTraffic(access({}))).toBe(true);
    expect(isDashboardTraffic(access({ route_pattern: '/api/v1/ws' }))).toBe(true);
    expect(isDashboardTraffic(access({ status: 304 }))).toBe(true);
    expect(isDashboardTraffic(access({ method: 'HEAD' }))).toBe(true);
    expect(isDashboardTraffic(logRecord(1, { module: 'ws.hub', msg: 'ws connected' }))).toBe(true);
    expect(isDashboardTraffic(logRecord(1, { module: 'ws.hub', msg: 'ws disconnected' }))).toBe(
      true,
    );
  });
  it('never hides writes, failures, MCP traffic, hub problems or other modules', () => {
    expect(isDashboardTraffic(access({ method: 'POST', route_pattern: 'login' }))).toBe(false);
    expect(isDashboardTraffic(access({ status: 404 }))).toBe(false);
    expect(isDashboardTraffic(access({ status: 500 }))).toBe(false);
    expect(isDashboardTraffic(access({ route_pattern: '/mcp' }))).toBe(false);
    expect(isDashboardTraffic(logRecord(1, { method: 'GET', status: 200 }))).toBe(false);
    expect(
      isDashboardTraffic(
        logRecord(1, { module: 'ws.hub', level: 'error', msg: 'ws command failed' }),
      ),
    ).toBe(false);
  });
});

/** @module infra/logging/level-spec.test — level-spec grammar. */

import { describe, expect, it } from 'bun:test';
import {
  effectiveLevel,
  formatLevelSpec,
  isLogLevel,
  LOG_MODULES,
  levelEnabled,
  moduleRoot,
  parseLevelSpec,
  toLevelSpec,
} from './level-spec.ts';

describe('parseLevelSpec', () => {
  it('parses a bare level and per-module overrides', () => {
    expect(parseLevelSpec('info')).toEqual({ ok: true, value: { default: 'info', modules: {} } });
    expect(parseLevelSpec(' INFO , sessions=debug,persistence=TRACE ')).toEqual({
      ok: true,
      value: { default: 'info', modules: { sessions: 'debug', persistence: 'trace' } },
    });
  });

  it('rejects unknown levels, modules and malformed pairs', () => {
    const cases: Array<[string, string]> = [
      ['', 'empty level spec'],
      ['verbose', "unknown level 'verbose'"],
      ['info,sessions', "expected '<module>=<level>'"],
      ['info,bogus=debug', "unknown log module 'bogus'"],
      ['info,sessions=loud', "unknown level 'loud' for module 'sessions'"],
    ];
    for (const [input, fragment] of cases) {
      const r = parseLevelSpec(input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain(fragment);
    }
  });

  it('round-trips through formatLevelSpec', () => {
    const r = parseLevelSpec('warn,ws=debug,http=trace');
    expect(r.ok).toBe(true);
    if (r.ok) expect(formatLevelSpec(r.value)).toBe('warn,http=trace,ws=debug');
  });

  it('accepts every registered module', () => {
    for (const m of LOG_MODULES) expect(parseLevelSpec(`info,${m}=debug`).ok).toBe(true);
  });
});

describe('effectiveLevel / levelEnabled', () => {
  const spec = toLevelSpec({ default: 'info', modules: { sessions: 'debug', http: 'warn' } });

  it('matches the module root of a dotted module name', () => {
    expect(moduleRoot('sessions.lifecycle')).toBe('sessions');
    expect(moduleRoot(undefined)).toBeUndefined();
    expect(effectiveLevel(spec, 'sessions.lifecycle')).toBe('debug');
    expect(effectiveLevel(spec, 'http')).toBe('warn');
    expect(effectiveLevel(spec, 'vault')).toBe('info');
    expect(effectiveLevel(spec, undefined)).toBe('info');
  });

  it('orders levels error < warn < info < debug < trace', () => {
    expect(levelEnabled('info', 'error')).toBe(true);
    expect(levelEnabled('info', 'info')).toBe(true);
    expect(levelEnabled('info', 'debug')).toBe(false);
    expect(levelEnabled('trace', 'trace')).toBe(true);
    expect(levelEnabled('error', 'warn')).toBe(false);
  });

  it('isLogLevel', () => {
    expect(isLogLevel('trace')).toBe(true);
    expect(isLogLevel('silly')).toBe(false);
    expect(toLevelSpec('debug')).toEqual({ default: 'debug', modules: {} });
  });
});

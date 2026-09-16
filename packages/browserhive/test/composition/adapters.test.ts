/** @module test/composition/adapters.test — HTTP port adapters, the degradation relay and the dashboard locator. */

import { describe, expect, it } from 'bun:test';
import { isAppError } from '@browserhive/core/runtime';
import { DegradationRelay } from '../../src/composition/adapters/degradation-relay.ts';
import { logLevelController } from '../../src/composition/adapters/http-ports.ts';
import { resolveDashboardDir } from '../../src/composition/index.ts';
import { cancelAttentionOf } from '../../src/composition/phases/listeners-http.ts';

describe('logLevelController', () => {
  it('applies a spec and returns the normalised form; rejects bad specs and unknown modules', () => {
    let current: unknown;
    const logger = {
      setLevel: (spec: unknown) => {
        current = spec;
      },
      getLevel: () => ({ default: 'debug' as const, modules: { sessions: 'trace' as const } }),
    };
    const controller = logLevelController(logger, ['sessions']);
    expect(controller.set('debug,sessions=trace')).toBe('debug,sessions=trace');
    expect(current).toEqual({ default: 'debug', modules: { sessions: 'trace' } });
    for (const bad of ['loud', 'info,nope=debug']) {
      try {
        controller.set(bad);
        throw new Error('expected VALIDATION_FAILED');
      } catch (err) {
        expect(isAppError(err) && err.code).toBe('VALIDATION_FAILED');
      }
    }
  });
});

describe('DegradationRelay', () => {
  it('buffers reports until attached, then forwards directly', () => {
    const relay = new DegradationRelay();
    const seen: string[] = [];
    relay.report({ code: 'A', severity: 'warn', message: 'a' });
    relay.recovered('A');
    relay.attach({
      report: (d) => void seen.push(`report:${d.code}`),
      recovered: (code) => void seen.push(`recovered:${code}`),
      unhandled: (_e, kind) => void seen.push(`unhandled:${kind}`),
    });
    relay.unhandled(new Error('x'), 'rejection');
    expect(seen).toEqual(['report:A', 'recovered:A', 'unhandled:rejection']);
  });
});

describe('resolveDashboardDir', () => {
  it('finds dist/dashboard next to a bundle and packages/dashboard/dist from source', () => {
    const files = new Set([
      '/pkg/dist/dashboard/index.html',
      '/pkg/dist/dashboard/assets',
      '/repo/packages/dashboard/dist/index.html',
      '/repo/packages/dashboard/dist/assets',
    ]);
    const exists = (p: string) => files.has(p);
    expect(resolveDashboardDir('file:///pkg/dist/index.js', exists)).toBe('/pkg/dist/dashboard');
    expect(
      resolveDashboardDir(
        'file:///repo/packages/browserhive/src/composition/dashboard-dir.ts',
        exists,
      ),
    ).toBe('/repo/packages/dashboard/dist');
    expect(resolveDashboardDir('file:///elsewhere/x.js', () => false)).toBeUndefined();
  });
});

describe('cancelAttentionOf', () => {
  it('cancels only the open attention requests of the principal', async () => {
    const cancelled: string[] = [];
    const broker = {
      listOpen: () => [
        { requestId: 'a-1', owner: 'agent-1' },
        { requestId: 'a-2', owner: 'agent-2' },
        { requestId: 'a-3', owner: 'agent-1' },
      ],
      cancel: async (id: string) => {
        cancelled.push(id);
        return true;
      },
    };
    expect(await cancelAttentionOf(broker as never, 'agent-1')).toBe(2);
    expect(cancelled).toEqual(['a-1', 'a-3']);
  });
});

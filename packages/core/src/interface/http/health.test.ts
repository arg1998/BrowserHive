/** @module interface/http/health.test — `/health` is public and phase-driven: 503 until ready, 200 when ready, 503 while stopping. */

import { describe, expect, it } from 'bun:test';
import { HealthResponse } from '@browserhive/contracts/http';
import { createHttpKit } from '../../../test/helpers/http-kit.ts';

describe('/health', () => {
  it('follows the boot phase', async () => {
    const kit = await createHttpKit({ seed: false });
    kit.health.set('starting', 'open-storage', 'pending');
    const starting = await kit.request('GET', '/health');
    expect(starting.status).toBe(503);
    expect(HealthResponse.parse(await starting.json()).phase).toBe('open-storage');
    kit.health.set('ready', 'ready', 'ok');
    const ready = await kit.request('GET', '/health');
    expect(ready.status).toBe(200);
    expect(HealthResponse.parse(await ready.json()).uptime_ms).toBe(60_000);
    kit.health.set('stopping', 'stopping', 'ok');
    expect((await kit.request('GET', '/health')).status).toBe(503);
    kit.health.set('degraded', 'ready', 'degraded');
    expect((await kit.request('GET', '/api/v1/health')).status).toBe(503);
  });

  it('a degraded 503 still carries the full health body as JSON', async () => {
    const kit = await createHttpKit({ seed: false });
    kit.health.set('degraded', 'ready', 'degraded');
    for (const path of ['/health', '/api/v1/health']) {
      const res = await kit.request('GET', path);
      expect(res.status).toBe(503);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(HealthResponse.parse(await res.json())).toEqual({
        status: 'degraded',
        phase: 'ready',
        version: '0.1.0',
        uptime_ms: 60_000,
        checks: { db: 'degraded', browser: 'degraded', listeners: 'degraded' },
      });
    }
  });
});

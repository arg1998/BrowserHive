/** @module composition/phases/domain-templates.test — BrowserHive's own origins for a template host's self-origin guard and marker cookie (spec 13 §3.8). */

import { describe, expect, it } from 'bun:test';
import type { ServerConfig } from '@browserhive/contracts/config';
import { selfOriginsOf } from './domain-templates.ts';

const MACHINE = { hostname: 'box', addresses: ['192.168.1.20', 'fe80::1'] };

function config(overrides: Partial<ServerConfig>): ServerConfig {
  return { host: '127.0.0.1', port: 9876, allowedHosts: [], ...overrides } as ServerConfig;
}

describe('selfOriginsOf', () => {
  it('a loopback bind: the canonical loopback names, allowedHosts and publicUrl', () => {
    const origins = selfOriginsOf(
      config({ allowedHosts: ['hive.lan'], publicUrl: 'https://hive.example.com' }),
      MACHINE,
    );
    expect(origins).toContain('http://127.0.0.1:9876');
    expect(origins).toContain('http://localhost:9876');
    expect(origins).toContain('http://[::1]:9876');
    expect(origins).toContain('http://hive.lan:9876');
    expect(origins).toContain('https://hive.example.com');
    expect(origins.some((o) => o.includes('192.168.1.20'))).toBe(false);
  });

  it('a wildcard bind adds the machine name and every interface address', () => {
    const origins = selfOriginsOf(config({ host: '0.0.0.0' }), MACHINE);
    for (const origin of [
      'http://0.0.0.0:9876',
      'http://box:9876',
      'http://box.local:9876',
      'http://192.168.1.20:9876',
      'http://[fe80::1]:9876',
    ]) {
      expect(origins).toContain(origin);
    }
  });

  it('nothing for an ephemeral port that is not known yet', () => {
    expect(selfOriginsOf(config({ port: 0 }), MACHINE)).toEqual([]);
  });
});

/** @module composition/phases/domain-templates.test — BrowserHive's own origins for a template host's self-origin guard and marker cookie (spec 13 §3.8), and the template key at boot (spec 13 §2.4; review #79 M-3). */

import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerConfig } from '@browserhive/contracts/config';
import { selfOriginsOf, type TemplatesInput, templateStateStore } from './domain-templates.ts';

const MACHINE = { hostname: 'box', addresses: ['192.168.1.20', 'fe80::1'] };

function config(overrides: Partial<ServerConfig>): ServerConfig {
  return { host: '127.0.0.1', port: 9876, allowedHosts: [], ...overrides } as ServerConfig;
}

describe('selfOriginsOf', () => {
  it('a loopback bind: the canonical loopback names, allowedHosts and publicUrl', () => {
    const origins = selfOriginsOf(
      config({ allowedHosts: ['hive.lan'], publicUrl: 'https://hive.example.com' }),
      () => MACHINE,
    );
    expect(origins).toContain('http://127.0.0.1:9876');
    expect(origins).toContain('http://localhost:9876');
    expect(origins).toContain('http://[::1]:9876');
    expect(origins).toContain('http://hive.lan:9876');
    expect(origins).toContain('https://hive.example.com');
    expect(origins.some((o) => o.includes('192.168.1.20'))).toBe(false);
  });

  it('a wildcard bind adds the machine name and every interface address', () => {
    const origins = selfOriginsOf(config({ host: '0.0.0.0' }), () => MACHINE);
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
    expect(selfOriginsOf(config({ port: 0 }), () => MACHINE)).toEqual([]);
  });
});

describe('the template key at boot (review #79 M-3)', () => {
  async function boot(dataDir: string, templates: boolean) {
    const reports: { code: string; details?: unknown }[] = [];
    const logs: string[] = [];
    const logger = {
      error: (msg: string) => void logs.push(msg),
      warn: (msg: string) => void logs.push(msg),
      info: () => undefined,
      debug: () => undefined,
      trace: () => undefined,
      child: () => logger,
    };
    const input = {
      config: { dataDir, templates } as ServerConfig,
      logger,
      degradations: {
        report: (d: { code: string }) => void reports.push(d),
        recovered: () => undefined,
      },
      uow: { repos: { templateVersions: { listAll: async () => [] }, templates: {} } },
    } as unknown as TemplatesInput;
    const store = await templateStateStore(input, join(dataDir, 'templates'));
    return { store, reports, logs };
  }

  it('templates=false resolves and creates no key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bh-key-boot-'));
    try {
      const { store } = await boot(dir, false);
      expect(store.keys.current).toBeNull();
      expect(
        await stat(join(dir, 'admin')).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a key file that cannot be created is a degradation, never a failed boot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bh-key-boot-'));
    try {
      // `admin` is a file: the directory and the key cannot be created.
      await writeFile(join(dir, 'admin'), 'not a directory');
      const { store, reports } = await boot(dir, true);
      expect(store.keys.current).toBeNull();
      expect(reports.map((r) => r.code)).toEqual(['TEMPLATE_KEY_MISSING']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('creates the key file when nothing is encrypted yet', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bh-key-boot-'));
    try {
      const { store, reports } = await boot(dir, true);
      expect(store.keys.current).not.toBeNull();
      expect(reports).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

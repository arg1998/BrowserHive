/** @module test/composition/testing-seam.test — the `BHDEV_TESTING=1` guard of the internal testing seam (D-63): `browserhive/testing` refuses to load and `createServer({ testing })` refuses without it; the switches it adds. */

import { afterEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { TESTING_ENV, testingArgsOf, testingEnabled } from '../../src/composition/testing-seam.ts';
import { ConfigError, createServer } from '../../src/index.ts';
import { tempDir } from './support.ts';

const silent = { stdout: () => undefined, stderr: () => undefined };
const TESTING_ENTRY = join(import.meta.dir, '../../src/testing.ts');

/** Imports the `browserhive/testing` entry in a fresh process (a module that threw stays cached). */
async function importEntry(value: string | undefined): Promise<{ code: number; stderr: string }> {
  const env: Record<string, string> = {};
  for (const [name, v] of Object.entries(process.env)) {
    if (v !== undefined && name !== TESTING_ENV) env[name] = v;
  }
  if (value !== undefined) env[TESTING_ENV] = value;
  const child = Bun.spawn(
    [process.execPath, '-e', `await import(${JSON.stringify(TESTING_ENTRY)});`],
    { env, stdout: 'ignore', stderr: 'pipe' },
  );
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { code, stderr };
}

describe('testing seam guard (D-63)', () => {
  const saved = process.env[TESTING_ENV];
  afterEach(() => {
    if (saved === undefined) delete process.env[TESTING_ENV];
    else process.env[TESTING_ENV] = saved;
  });

  it('is enabled only by BHDEV_TESTING=1 exactly', () => {
    expect(TESTING_ENV).toBe('BHDEV_TESTING');
    expect(TESTING_ENV.startsWith('BHDEV_')).toBe(true);
    expect(testingEnabled({ BHDEV_TESTING: '1' })).toBe(true);
    for (const value of [undefined, '', '0', 'true', 'yes', ' 1'])
      expect(testingEnabled({ BHDEV_TESTING: value })).toBe(false);
  });

  it('browserhive/testing throws at import without the variable, naming it', async () => {
    const refused = await importEntry(undefined);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain('BHDEV_TESTING=1');
    expect((await importEntry('true')).code).not.toBe(0);
    expect((await importEntry('1')).code).toBe(0);
  });

  it('createServer({ testing }) is refused without the variable, accepted with it', async () => {
    const dir = tempDir('bh-testing-seam-');
    try {
      const options = {
        port: 0,
        dataDir: dir.path,
        env: { [TESTING_ENV]: '1' },
        configFile: false as const,
        output: silent,
        testing: { hostResolverRules: 'MAP *.test:443 127.0.0.1:1' },
      };
      delete process.env[TESTING_ENV];
      const refused = await createServer(options).catch((err: unknown) => err);
      expect(refused).toBeInstanceOf(ConfigError);
      if (refused instanceof ConfigError) {
        expect(refused.code).toBe('CONFIG_INVALID');
        expect(refused.exitCode).toBe(64);
        expect(refused.problems[0]?.location).toBe('options.testing');
        expect(refused.message).toContain('BHDEV_TESTING=1');
      }
      // Without `testing` nothing changes.
      const { testing: _unused, ...plain } = options;
      await expect(createServer(plain)).resolves.toBeDefined();

      process.env[TESTING_ENV] = '1';
      await expect(createServer(options)).resolves.toBeDefined();
    } finally {
      dir.cleanup();
    }
  });

  it('adds only the switches that are given', () => {
    expect(testingArgsOf(undefined)).toEqual([]);
    expect(testingArgsOf({})).toEqual([]);
    expect(
      testingArgsOf({
        hostResolverRules: 'MAP *.test:443 127.0.0.1:8443',
        ignoreCertificateErrorsSpkiList: 'abc=',
      }),
    ).toEqual([
      '--host-resolver-rules=MAP *.test:443 127.0.0.1:8443',
      '--ignore-certificate-errors-spki-list=abc=',
    ]);
  });
});

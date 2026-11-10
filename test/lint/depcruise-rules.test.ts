/** @module test/lint/depcruise-rules — the dependency-cruiser rules fire: each one is run against a fixture tree that breaks it (an inert rule fails here). */

import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const FIXTURES = 'test/fixtures/depcruise';

/**
 * A copy of the real config whose `packages/…` paths point into the fixture tree, so the same rules
 * judge files that break them on purpose. Everything else (options, npm paths) is unchanged.
 */
function fixtureConfig(dir: string): string {
  const file = join(dir, 'depcruise.fixture.cjs');
  writeFileSync(
    file,
    `const real = require(${JSON.stringify(join(ROOT, '.dependency-cruiser.cjs'))});
const point = (v) =>
  typeof v === 'string' ? v.replace(/^\\^packages\\//, '^${FIXTURES}/packages/') : Array.isArray(v) ? v.map(point) : v;
const side = (s) => (s === undefined ? s : { ...s, ...(s.path !== undefined && { path: point(s.path) }), ...(s.pathNot !== undefined && { pathNot: point(s.pathNot) }) });
module.exports = { ...real, forbidden: real.forbidden.map((r) => ({ ...r, from: side(r.from), to: side(r.to) })) };
`,
  );
  return file;
}

interface Violation {
  readonly from: string;
  readonly to: string;
  readonly rule: { readonly name: string };
}

function cruise(): Violation[] {
  const dir = mkdtempSync(join(tmpdir(), 'bh-depcruise-'));
  try {
    const run = Bun.spawnSync(
      [
        process.execPath,
        'node_modules/dependency-cruiser/bin/dependency-cruiser.mjs',
        '--config',
        fixtureConfig(dir),
        '--output-type',
        'json',
        FIXTURES,
      ],
      { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' },
    );
    const parsed: unknown = JSON.parse(run.stdout.toString());
    const summary = (parsed as { summary?: { violations?: Violation[] } }).summary;
    return summary?.violations ?? [];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('dependency-cruiser rules', () => {
  const violations = cruise();
  const hits = (rule: string): string[] =>
    violations.filter((v) => v.rule.name === rule).map((v) => `${v.from} -> ${v.to}`);

  it('interface/ may not import Playwright or Patchright types (spec 13 §3.13)', () => {
    const found = hits('interface-no-playwright');
    expect(found.some((h) => h.includes('node_modules/playwright/'))).toBe(true);
    expect(found.some((h) => h.includes('node_modules/patchright-core/'))).toBe(true);
  });

  it('drivers only under infra/browsers, also patchright-core', () => {
    expect(hits('playwright-only-in-browsers').some((h) => h.includes('patchright-core'))).toBe(
      true,
    );
  });

  it('Kysely only under infra/persistence, although it resolves into its dist/', () => {
    expect(hits('sqlite-only-in-persistence').some((h) => h.includes('node_modules/kysely/'))).toBe(
      true,
    );
  });

  it('contracts stay platform-neutral: node: modules are refused', () => {
    expect(hits('contracts-platform-neutral').some((h) => h.includes('uses-node'))).toBe(true);
  });

  it("contracts stay platform-neutral: Bun's modules are refused", () => {
    const bun = [...hits('contracts-platform-neutral'), ...hits('contracts-platform-neutral-bun')];
    const targets = new Set(
      bun.filter((h) => h.includes('uses-bun')).map((h) => h.split(' -> ')[1]),
    );
    expect([...targets].sort()).toEqual(['bun', 'bun:sqlite']);
  });

  it("reading a driver's package.json is no violation", () => {
    expect(violations.filter((v) => v.from.includes('reads-driver-version'))).toEqual([]);
  });
});

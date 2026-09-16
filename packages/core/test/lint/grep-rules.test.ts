/** @module test/lint/grep-rules — source-scan rules Biome cannot express (spec 05 §10). */

import { describe, expect, it } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

/** Repository root (this file lives at packages/core/test/lint). */
const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..');

/** Longest allowed log message literal (pretty renderer message column). */
const MAX_LOG_MESSAGE_LENGTH = 26;

const PACKAGES = ['contracts', 'core', 'dashboard', 'browserhive'];

const SKIP_DIRS = new Set(['node_modules', 'dist', 'generated', 'coverage']);

/** Generated or vendored files are not held to the rules. */
function isGenerated(rel: string): boolean {
  return (
    rel.endsWith('.gen.ts') ||
    rel.endsWith('.gen.tsx') ||
    rel.endsWith('.d.ts') ||
    rel.endsWith('routeTree.gen.ts') ||
    rel === toPosix(join('packages', 'core', 'src', 'version.ts')) ||
    rel.includes('/generated/')
  );
}

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

function isTest(rel: string): boolean {
  return /\.test\.tsx?$/.test(rel) || rel.includes('/test/') || rel.includes('/__tests__/');
}

interface SourceFile {
  readonly rel: string;
  readonly text: string;
  readonly lines: readonly string[];
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
}

function loadSources(): SourceFile[] {
  const files: string[] = [];
  for (const pkg of PACKAGES) {
    const src = join(REPO_ROOT, 'packages', pkg, 'src');
    if (existsSync(src)) walk(src, files);
  }
  return files
    .map((full) => ({ rel: toPosix(relative(REPO_ROOT, full)), text: readFileSync(full, 'utf8') }))
    .filter((f) => !isGenerated(f.rel))
    .map((f) => ({ ...f, lines: f.text.split('\n') }));
}

const SOURCES = loadSources();

/** Collects `file:line: text` for every line matching `re` in files passing `filter`. */
function violations(
  re: RegExp,
  filter: (file: SourceFile) => boolean = () => true,
  lineFilter: (line: string) => boolean = () => true,
): string[] {
  const out: string[] = [];
  for (const file of SOURCES) {
    if (!filter(file)) continue;
    file.lines.forEach((line, i) => {
      if (re.test(line) && lineFilter(line)) out.push(`${file.rel}:${i + 1}: ${line.trim()}`);
    });
  }
  return out;
}

const notTest = (f: SourceFile): boolean => !isTest(f.rel);
const isComment = (line: string): boolean => /^\s*(\/\/|\*|\/\*)/.test(line);

describe('grep rules (spec 05 §10)', () => {
  it('scans at least the core package', () => {
    expect(SOURCES.some((f) => f.rel.startsWith('packages/core/src/'))).toBe(true);
  });

  it('no String(err) or template-interpolated errors; use serializeError', () => {
    // Spec 05 §5.2 names `String(err)`, `${err}` and `err.message` concatenation (identifier `err`).
    expect(
      violations(
        /\bString\(err\)|\$\{err\}|\berr\.message\s*\+|\+\s*err\.message\b/,
        notTest,
        (l) => !isComment(l),
      ),
    ).toEqual([]);
  });

  it('no bare TODO/FIXME (use TODO(#123))', () => {
    expect(violations(/\b(TODO|FIXME)\b(?!\(#\d+\))/, () => true)).toEqual([]);
  });

  it('no `export *`', () => {
    expect(violations(/^\s*export\s+\*\s+from/, () => true)).toEqual([]);
  });

  it('no process.env outside the config resolver and the composition root', () => {
    const allowed = (rel: string): boolean =>
      rel.startsWith('packages/browserhive/src/composition/') ||
      rel.startsWith('packages/core/src/app/config/') ||
      rel.startsWith('packages/browserhive/src/cli/') ||
      rel.startsWith('packages/dashboard/');
    expect(
      violations(
        /\bprocess\.env\b/,
        (f) => notTest(f) && !allowed(f.rel),
        (l) => !isComment(l),
      ),
    ).toEqual([]);
  });

  it('no Date.now()/nanoid outside packages/core/src/infra', () => {
    // The dashboard's single browser-clock site; everything else takes an injected `Clock`.
    const allowed = (rel: string): boolean =>
      rel.startsWith('packages/core/src/infra/') || rel === 'packages/dashboard/src/lib/clock.ts';
    expect(
      violations(
        /\bDate\.now\(\)|\bnanoid\(|\bcustomAlphabet\(|from\s+['"]nanoid['"]/,
        (f) => notTest(f) && !allowed(f.rel),
        (l) => !isComment(l),
      ),
    ).toEqual([]);
  });

  it('no console.* outside the CLI output module', () => {
    const allowed = (rel: string): boolean =>
      rel.startsWith('packages/browserhive/src/cli/output/');
    expect(
      violations(
        /(^|[^.\w])console\.(log|info|debug|warn|error|trace|table|dir)\(/,
        (f) => notTest(f) && !allowed(f.rel),
        (l) => !isComment(l),
      ),
    ).toEqual([]);
  });

  it('log message literals are ≤ 26 chars and never interpolated', () => {
    const re = /\.(error|warn|info|debug|trace)\(\s*(['"`])((?:(?!\2).)*)\2/g;
    const out: string[] = [];
    for (const file of SOURCES) {
      if (isTest(file.rel)) continue;
      file.lines.forEach((line, i) => {
        if (isComment(line)) return;
        for (const match of line.matchAll(re)) {
          const quote = match[2];
          const message = match[3] ?? '';
          if (quote === '`' && message.includes('${')) {
            out.push(`${file.rel}:${i + 1}: interpolated log message`);
          } else if (message.length > MAX_LOG_MESSAGE_LENGTH) {
            out.push(`${file.rel}:${i + 1}: message "${message}" is ${message.length} chars`);
          }
        }
      });
    }
    expect(out).toEqual([]);
  });

  it('no dangerouslySetInnerHTML in the dashboard', () => {
    expect(
      violations(/dangerouslySetInnerHTML/, (f) => f.rel.startsWith('packages/dashboard/')),
    ).toEqual([]);
  });

  it('every source file starts with a `/** @module … */` header', () => {
    const missing: string[] = [];
    for (const file of SOURCES) {
      const head = file.text
        .replace(/^﻿/, '')
        .replace(/^#![^\n]*\n/, '')
        .trimStart();
      // Scaffold placeholders (`export {};`) are not modules yet.
      if (head.trim() === 'export {};') continue;
      if (!head.startsWith('/** @module ')) missing.push(file.rel);
    }
    expect(missing).toEqual([]);
  });
});

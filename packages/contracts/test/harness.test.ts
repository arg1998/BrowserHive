/** @module test/harness — the harness vocabulary (spec 02 §1.4, D-30): aliases, normalisation, labels, the metric fold and the meta-bag caps. */
import { describe, expect, it } from 'bun:test';
import {
  CLIENT_NAME_ALIASES,
  capMetaBag,
  HARNESS_LABELS,
  HARNESS_SLUGS,
  harnessFromClientName,
  harnessFromUserAgent,
  harnessLabel,
  harnessSourceLabel,
  isKnownHarness,
  META_MAX_KEYS,
  META_MAX_TOTAL_BYTES,
  META_MAX_VALUE_BYTES,
  metricHarness,
  normalizeHarness,
  sanitizeHarnessSlug,
} from '../src/harness/index.ts';

describe('harness tables', () => {
  it('labels every known slug and keeps unknown and other', () => {
    for (const slug of HARNESS_SLUGS) expect(HARNESS_LABELS[slug].length).toBeGreaterThan(0);
    expect(HARNESS_SLUGS).toContain('unknown');
    expect(HARNESS_SLUGS).toContain('other');
  });

  it('maps every alias to a known slug', () => {
    for (const slug of Object.values(CLIENT_NAME_ALIASES)) expect(isKnownHarness(slug)).toBe(true);
  });
});

describe('harnessFromClientName', () => {
  const rows: readonly (readonly [string | null, string])[] = [
    ['claude-code', 'claude-code'],
    ['claude-ai', 'claude-desktop'],
    ['codex-mcp-client', 'codex'],
    ['cursor-vscode', 'cursor'],
    ['cursor-agent', 'cursor-cli'],
    ['opencode', 'opencode'],
    ['gemini-cli-mcp-client', 'gemini-cli'],
    ['Visual Studio Code', 'vscode'],
    ['Visual Studio Code - Insiders', 'vscode'],
    ['Cline', 'cline'],
    ['Zed', 'zed'],
    ['continue-client', 'continue'],
    ['goose-cli', 'goose'],
    ['goose-desktop', 'goose'],
    ['@n8n/n8n-nodes-langchain.mcpClientTool', 'n8n'],
    ['JetBrains-IU/copilot-intellij', 'jetbrains'],
    ['github-copilot-developer', 'copilot-cli'],
    // Generic SDK defaults identify nothing.
    ['mcp', 'unknown'],
    ['mcp-client', 'unknown'],
    ['example-client', 'unknown'],
    ['test-client', 'unknown'],
    ['', 'unknown'],
    [null, 'unknown'],
    // Unrecognised names are kept, sanitised.
    ['My Agent 2', 'my-agent-2'],
    ['Anthropic/ClaudeAI', 'anthropic-claudeai'],
  ];
  for (const [name, slug] of rows) {
    it(`${JSON.stringify(name)} → ${slug}`, () => {
      expect(harnessFromClientName(name)).toBe(slug);
    });
  }
});

describe('harnessFromUserAgent', () => {
  const rows: readonly (readonly [string | null, string | null])[] = [
    ['codex-mcp-client/0.154.0', 'codex'],
    ['claude-code/2.1.282 (sdk-cli)', 'claude-code'],
    ['opencode/1.18.31', 'opencode'],
    ['Cursor/1.7.3 (linux x64)', 'cursor'],
    [
      'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Claude/0.14.10 Chrome/138.0 Electron/37.2.0 Safari/537.36',
      'claude-desktop',
    ],
    ['node', null],
    ['python-httpx/0.28.1', null],
    ['undici', null],
    [null, null],
  ];
  for (const [ua, slug] of rows) {
    it(`${JSON.stringify(ua)} → ${slug}`, () => {
      expect<string | null>(harnessFromUserAgent(ua)).toBe(slug);
    });
  }
});

describe('normalizeHarness (declared values)', () => {
  const rows: readonly (readonly [string | null | undefined, string | null])[] = [
    ['claude-code', 'claude-code'],
    ['Claude Code', 'claude-code'],
    ['claude_code', 'claude-code'],
    ['CLAUDECODE', 'claude-code'],
    ['Gemini CLI', 'gemini-cli'],
    ['gemini', 'gemini-cli'],
    ['VS Code', 'vscode'],
    ['codex-mcp-client', 'codex'],
    ['unknown', 'unknown'],
    ['other', 'other'],
    ['  opencode  ', 'opencode'],
    ['Nightly Scraper!', 'nightly-scraper'],
    ['a'.repeat(40), 'a'.repeat(32)],
    ['', null],
    ['   ', null],
    ['!!!', null],
    [null, null],
    [undefined, null],
  ];
  for (const [raw, slug] of rows) {
    it(`${JSON.stringify(raw)} → ${slug}`, () => {
      expect(normalizeHarness(raw)).toBe(slug);
    });
  }

  it('is idempotent', () => {
    for (const slug of [...HARNESS_SLUGS, 'nightly-scraper']) {
      expect(normalizeHarness(slug)).toBe(slug);
    }
  });

  it('sanitises to [a-z0-9-] without leading or trailing dashes', () => {
    expect(sanitizeHarnessSlug('--Hello__World--')).toBe('hello-world');
    expect(sanitizeHarnessSlug(`${'a'.repeat(31)}-b`)).toBe('a'.repeat(31));
  });
});

describe('labels, sources and the metric fold', () => {
  it('labels known slugs and shows other slugs as themselves', () => {
    expect(harnessLabel('claude-code')).toBe('Claude Code');
    expect(harnessLabel('unknown')).toBe('Unknown');
    expect(harnessLabel('nightly-scraper')).toBe('nightly-scraper');
    expect(harnessLabel(null)).toBe('Unknown');
  });

  it('folds every slug outside the table into other', () => {
    expect(metricHarness('codex')).toBe('codex');
    expect(metricHarness('unknown')).toBe('unknown');
    expect(metricHarness('nightly-scraper')).toBe('other');
    expect(metricHarness(null)).toBe('unknown');
  });

  it('phrases sources and keeps unknown sources as given', () => {
    expect(harnessSourceLabel('client_info')).toBe('from clientInfo');
    expect(harnessSourceLabel(null)).toBe('not identified');
    expect(harnessSourceLabel('token')).toBe('token');
  });
});

describe('capMetaBag', () => {
  it('keeps strings and stringifies numbers and booleans', () => {
    const { meta, dropped } = capMetaBag([
      ['team', 'growth'],
      ['run', 42],
      ['ci', true],
      ['nested', { a: 1 }],
      ['nothing', null],
    ]);
    expect(meta).toEqual({ team: 'growth', run: '42', ci: 'true' });
    expect(dropped).toBe(2);
  });

  it(`keeps at most ${META_MAX_KEYS} keys`, () => {
    const entries = Array.from({ length: 20 }, (_, i) => [`k${i}`, 'v'] as const);
    const { meta, dropped } = capMetaBag(entries);
    expect(Object.keys(meta)).toHaveLength(META_MAX_KEYS);
    expect(dropped).toBe(4);
  });

  it(`drops values over ${META_MAX_VALUE_BYTES} bytes (UTF-8) and keys over 64 characters`, () => {
    const { meta, dropped } = capMetaBag([
      ['ok', 'a'.repeat(META_MAX_VALUE_BYTES)],
      ['big', 'a'.repeat(META_MAX_VALUE_BYTES + 1)],
      ['wide', 'é'.repeat(129)],
      ['k'.repeat(65), 'v'],
      ['', 'v'],
    ]);
    expect(Object.keys(meta)).toEqual(['ok']);
    expect(dropped).toBe(4);
  });

  it(`stops at ${META_MAX_TOTAL_BYTES} bytes in total`, () => {
    const entries = Array.from(
      { length: 16 },
      (_, i) => [`${'k'.repeat(58)}${String(i).padStart(2, '0')}`, 'a'.repeat(256)] as const,
    );
    const { meta, dropped } = capMetaBag(entries);
    const total = Object.entries(meta).reduce((n, [k, v]) => n + k.length + v.length, 0);
    expect(total).toBeLessThanOrEqual(META_MAX_TOTAL_BYTES);
    expect(Object.keys(meta)).toHaveLength(12);
    expect(dropped).toBe(4);
  });

  it('keeps the first value of a repeated key', () => {
    expect(
      capMetaBag([
        ['a', '1'],
        ['a', '2'],
      ]).meta,
    ).toEqual({ a: '1' });
  });
});

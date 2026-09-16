/** @module domain/policies/blocklist.test — blocklist file grammar and matching cases, plus the atomic holder. */

import { describe, expect, it } from 'bun:test';
import {
  Blocklist,
  type BlocklistRules,
  EMPTY_BLOCKLIST,
  MAX_BLOCKLIST_ENTRIES,
  matchBlocklist,
  parseBlocklist,
} from './blocklist.ts';

/** Build rules from inline patterns, one per line. */
function list(...patterns: string[]): BlocklistRules {
  const parsed = parseBlocklist(patterns.join('\n'));
  if (!parsed.ok) throw new Error(parsed.error.reason);
  return parsed.value;
}

describe('parseBlocklist', () => {
  it('ignores blank lines and comments, and trims whitespace', () => {
    const bl = list(
      '# a comment',
      '',
      '   ',
      '  ads.example.com  ',
      '   # indented comment',
      'b.example.com',
    );
    expect(bl.entries.map((e) => e.pattern)).toEqual(['ads.example.com', 'b.example.com']);
  });

  it('records the source line number of each pattern, for operator diagnostics', () => {
    const bl = list('# header', 'first.com', '', 'second.com');
    expect(bl.entries).toEqual([
      { pattern: 'first.com', line: 2 },
      { pattern: 'second.com', line: 4 },
    ]);
  });

  it('lowercases patterns so matching is case-insensitive', () => {
    const bl = list('ADS.Example.COM');
    expect(bl.entries[0]?.pattern).toBe('ads.example.com');
    expect(matchBlocklist(bl, 'https://ADS.EXAMPLE.com/x')).not.toBeNull();
  });

  it('drops duplicates but reports them, so a redundant line is visible', () => {
    const bl = list('a.com', 'A.com', 'b.com');
    expect(bl.entries.map((e) => e.pattern)).toEqual(['a.com', 'b.com']);
    expect(bl.skipped).toHaveLength(1);
    expect(bl.skipped[0]?.reason).toContain('duplicate');
  });

  it('refuses a catch-all pattern rather than blocking the entire internet', () => {
    const bl = list('*', '*/*', 'real.com');
    expect(bl.entries.map((e) => e.pattern)).toEqual(['real.com']);
    expect(bl.skipped).toHaveLength(2);
    expect(bl.skipped[0]?.reason).toContain('every URL');
    // And a URL is still reachable, which is the point of the guard.
    expect(matchBlocklist(bl, 'https://anything.example')).toBeNull();
  });

  it('caps the entry count and says which lines were dropped', () => {
    const many = Array.from({ length: MAX_BLOCKLIST_ENTRIES + 3 }, (_, i) => `host${i}.example`);
    const bl = list(...many);
    expect(bl.entries).toHaveLength(MAX_BLOCKLIST_ENTRIES);
    expect(bl.skipped).toHaveLength(3);
    expect(bl.skipped[0]?.reason).toContain('cap');
  });

  it('handles CRLF line endings', () => {
    expect(list('a.com\r', 'b.com\r').entries.map((e) => e.pattern)).toEqual(['a.com', 'b.com']);
  });

  it('refuses a binary body outright', () => {
    const parsed = parseBlocklist(`a.com\n${String.fromCharCode(0, 1)}`);
    expect(parsed.ok).toBe(false);
  });

  it('an empty list is inactive and never matches', () => {
    expect(EMPTY_BLOCKLIST.entries).toHaveLength(0);
    expect(matchBlocklist(EMPTY_BLOCKLIST, 'https://example.com')).toBeNull();
  });
});

describe('matchBlocklist', () => {
  it('a bare host blocks the site root and everything beneath it', () => {
    const bl = list('example.com');
    expect(matchBlocklist(bl, 'https://example.com')).not.toBeNull();
    expect(matchBlocklist(bl, 'https://example.com/')).not.toBeNull();
    expect(matchBlocklist(bl, 'https://example.com/deep/path?q=1')).not.toBeNull();
    expect(matchBlocklist(bl, 'http://example.com/x')).not.toBeNull();
  });

  it('a bare host does NOT block a different host that merely contains it', () => {
    const bl = list('example.com');
    expect(matchBlocklist(bl, 'https://notexample.com/')).toBeNull();
    expect(matchBlocklist(bl, 'https://example.com.evil.test/')).toBeNull();
    // Nor a subdomain: that needs an explicit wildcard, so a rule cannot over-reach by accident.
    expect(matchBlocklist(bl, 'https://www.example.com/')).toBeNull();
  });

  it('a wildcard host blocks subdomains and their paths, but not the bare apex', () => {
    const bl = list('*.example.com');
    expect(matchBlocklist(bl, 'https://ads.example.com/')).not.toBeNull();
    expect(matchBlocklist(bl, 'https://a.b.example.com/pixel?id=1')).not.toBeNull();
    expect(matchBlocklist(bl, 'https://example.com/')).toBeNull();
  });

  it('a scheme-qualified pattern only blocks that scheme', () => {
    const bl = list('https://example.com/admin/*');
    expect(matchBlocklist(bl, 'https://example.com/admin/users')).not.toBeNull();
    expect(matchBlocklist(bl, 'http://example.com/admin/users')).toBeNull();
    expect(matchBlocklist(bl, 'https://example.com/public')).toBeNull();
  });

  it('a substring wildcard matches anywhere in the URL', () => {
    const bl = list('*doubleclick*');
    expect(matchBlocklist(bl, 'https://ads.doubleclick.net/pixel')).not.toBeNull();
    expect(matchBlocklist(bl, 'https://cdn.example.com/doubleclick/tag.js')).not.toBeNull();
    expect(matchBlocklist(bl, 'https://example.com/')).toBeNull();
  });

  it('reports which pattern matched, so the audit row and error message can name it', () => {
    const bl = list('a.example.com', '*.tracker.test');
    expect(matchBlocklist(bl, 'https://ads.tracker.test/x')?.pattern).toBe('*.tracker.test');
    expect(matchBlocklist(bl, 'https://a.example.com/')?.pattern).toBe('a.example.com');
    // The scheme-less form is what a bare host pattern matches; audit rows carry it.
    expect(matchBlocklist(bl, 'https://a.example.com/')?.matched).toBe('a.example.com');
  });

  it('keeps a non-default port as part of the host', () => {
    const bl = list('localhost:8080');
    expect(matchBlocklist(bl, 'http://localhost:8080/admin')).not.toBeNull();
    expect(matchBlocklist(bl, 'http://localhost:9090/admin')).toBeNull();
  });

  it('treats `.` and `/` as literals, so a pattern can never act as a regex', () => {
    const bl = list('a.b.com');
    expect(matchBlocklist(bl, 'https://axbxcom/')).toBeNull();
    expect(matchBlocklist(bl, 'https://a.b.com/')).not.toBeNull();
  });

  it('allows non-network and unparseable URLs rather than failing closed', () => {
    // Blocking `about:blank` would break every fresh tab; a non-URL is not a navigation target.
    const bl = list('*blank*', '*example*');
    expect(matchBlocklist(bl, 'about:blank')).toBeNull();
    expect(matchBlocklist(bl, 'data:text/html,<p>example</p>')).toBeNull();
    expect(matchBlocklist(bl, 'chrome://settings')).toBeNull();
    expect(matchBlocklist(bl, 'not a url at all')).toBeNull();
    expect(matchBlocklist(bl, '')).toBeNull();
  });

  it('matches ws:// and ftp:// as well as http(s)', () => {
    const bl = list('stream.example.com', 'files.example.com');
    expect(matchBlocklist(bl, 'wss://stream.example.com/socket')).not.toBeNull();
    expect(matchBlocklist(bl, 'ftp://files.example.com/pub')).not.toBeNull();
  });
});

describe('Blocklist holder', () => {
  it('starts empty and inactive, and swaps rules atomically with a version bump', () => {
    const holder = new Blocklist();
    expect(holder.active).toBe(false);
    expect(holder.size).toBe(0);
    expect(holder.version).toBe(0);
    expect(holder.match('https://x.example/')).toBeNull();
    const next = list('x.example');
    holder.replace(next);
    expect(holder.current()).toBe(next);
    expect(holder.active).toBe(true);
    expect(holder.version).toBe(1);
    expect(holder.match('https://x.example/')?.pattern).toBe('x.example');
  });
});

/** @module domain/policies/url-scheme.test — the parse table of agent-requested URLs and of main-frame commits (spec 13 T0d, D-57). */

import { describe, expect, it } from 'bun:test';
import { checkAgentUrl, refusedCommittedScheme } from './url-scheme.ts';

const EXCLUSIVE = { allowData: true } as const;
const VIRTUAL = { allowData: false } as const;

describe('checkAgentUrl', () => {
  const allowed: ReadonlyArray<readonly [string, string]> = [
    ['https://example.com/', 'https://example.com/'],
    ['http://127.0.0.1:8080/a?b=1#c', 'http://127.0.0.1:8080/a?b=1#c'],
    ['HTTPS://Example.COM/a b', 'https://example.com/a%20b'],
    ['  https://example.com  ', 'https://example.com/'],
    ['\thttps://example.com\n', 'https://example.com/'],
    ['ht\ttps://example.com', 'https://example.com/'],
    ['about:blank', 'about:blank'],
    ['ABOUT:blank', 'about:blank'],
    [
      'data:text/html,<h1>hello from browserhive</h1>',
      'data:text/html,<h1>hello from browserhive</h1>',
    ],
    ['DATA:text/plain,hi', 'data:text/plain,hi'],
  ];
  for (const [raw, href] of allowed) {
    it(`allows ${JSON.stringify(raw)} as ${href}`, () => {
      expect(checkAgentUrl(raw, EXCLUSIVE)).toEqual({ ok: true, value: { href } });
    });
  }

  const refused: ReadonlyArray<readonly [string, string]> = [
    ['file:///etc/hostname', 'file'],
    ['FILE:///etc/hostname', 'file'],
    ['file://localhost/etc/passwd', 'file'],
    ['chrome://version', 'chrome'],
    ['chrome://settings/passwords', 'chrome'],
    ['chrome-untrusted://terminal/', 'chrome-untrusted'],
    ['chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/x.html', 'chrome-extension'],
    ['devtools://devtools/bundled/inspector.html', 'devtools'],
    ['view-source:https://example.com/', 'view-source'],
    ['view-source:file:///etc/hostname', 'view-source'],
    ['javascript:alert(1)', 'javascript'],
    ['JavaScript:alert(1)', 'javascript'],
    ['JAVA\tSCRIPT:alert(1)', 'javascript'],
    ['java\nscript:alert(1)', 'javascript'],
    ['java\r\nscript:alert(1)', 'javascript'],
    ['  javascript:alert(1)', 'javascript'],
    ['\njavascript:alert(1)', 'javascript'],
    ['\u0000javascript:alert(1)', 'javascript'],
    ['blob:https://example.com/00000000-0000-0000-0000-000000000000', 'blob'],
    ['filesystem:https://example.com/temporary/x', 'filesystem'],
    ['mailto:someone@example.com', 'mailto'],
    ['tel:+10000000000', 'tel'],
    ['slack://open', 'slack'],
    ['ws://example.com/', 'ws'],
    ['ftp://example.com/', 'ftp'],
    ['about:version', 'about'],
    ['about:BLANK', 'about'],
    ['about:blank#x', 'about'],
    ['about:blank?x', 'about'],
    ['about:srcdoc', 'about'],
    ['localhost:3000', 'localhost'],
    ['127.0.0.1:3000', ''],
    ['example.com', ''],
    ['/relative/path', ''],
    ['//example.com/', ''],
    ['http://', ''],
    ['https://exa mple.com/', ''],
    ['', ''],
    ['   ', ''],
  ];
  for (const [raw, scheme] of refused) {
    it(`refuses ${JSON.stringify(raw)} as '${scheme}'`, () => {
      expect(checkAgentUrl(raw, EXCLUSIVE)).toEqual({ ok: false, error: { scheme } });
    });
  }

  it('refuses data: when data is not allowed (virtual sessions)', () => {
    expect(checkAgentUrl('data:text/html,x', VIRTUAL)).toEqual({
      ok: false,
      error: { scheme: 'data' },
    });
    expect(checkAgentUrl('https://example.com/', VIRTUAL).ok).toBe(true);
  });
});

describe('refusedCommittedScheme', () => {
  const kept = [
    'https://example.com/',
    'http://127.0.0.1:1/x',
    'about:blank',
    'about:blank#top',
    'about:srcdoc',
    'blob:https://example.com/00000000-0000-0000-0000-000000000000',
    'chrome-error://chromewebdata/',
    'data:text/html,x',
  ];
  for (const url of kept) {
    it(`keeps a page on ${url}`, () => {
      expect(refusedCommittedScheme(url, EXCLUSIVE)).toBeNull();
    });
  }

  const closed: ReadonlyArray<readonly [string, string]> = [
    ['file:///etc/hosts', 'file'],
    ['chrome://version/', 'chrome'],
    ['chrome-untrusted://terminal/', 'chrome-untrusted'],
    ['chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/x.html', 'chrome-extension'],
    ['devtools://devtools/bundled/inspector.html', 'devtools'],
    ['view-source:https://example.com/', 'view-source'],
    ['filesystem:https://example.com/temporary/x', 'filesystem'],
    ['about:version', 'about'],
    ['not a url', ''],
  ];
  for (const [url, scheme] of closed) {
    it(`closes a page on ${url}`, () => {
      expect(refusedCommittedScheme(url, EXCLUSIVE)).toBe(scheme);
    });
  }

  it('closes a data: page when data is not allowed (virtual sessions)', () => {
    expect(refusedCommittedScheme('data:text/html,x', VIRTUAL)).toBe('data');
  });
});

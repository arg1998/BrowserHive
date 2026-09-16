/** @module domain/vault/origin.test — origin-check cases plus domain-key and uri helpers */

import { describe, expect, it } from 'bun:test';
import {
  checkOrigin,
  domainKey,
  hostFromUri,
  isUrlAllowed,
  originsFromUris,
  pageScope,
} from './origin.ts';

describe('checkOrigin — scheme gate', () => {
  for (const url of [
    'file:///etc/passwd',
    'data:text/html,<h1>hi',
    'chrome://settings',
    'about:blank',
    'ftp://linkedin.com/x',
    'javascript:alert(1)',
  ]) {
    it(`rejects non-http(s) scheme: ${url}`, () => {
      const r = checkOrigin(url, ['linkedin.com', '*.linkedin.com']);
      expect(r.outcome).toBe('fail');
      expect(['bad_scheme', 'no_host']).toContain(r.reason ?? '');
    });
  }
});

describe('checkOrigin — exact host', () => {
  it('matches the exact host only, not subdomains', () => {
    expect(checkOrigin('https://linkedin.com/login', ['linkedin.com']).outcome).toBe('pass');
    expect(checkOrigin('https://www.linkedin.com/login', ['linkedin.com']).outcome).toBe('fail');
  });

  it('is case-insensitive and port-agnostic', () => {
    expect(checkOrigin('https://LinkedIn.com:443/x', ['linkedin.com']).outcome).toBe('pass');
    expect(checkOrigin('http://LinkedIn.com:8080/x', ['LINKEDIN.com']).outcome).toBe('pass');
  });

  it('matches IP literals and localhost exactly (no registrable domain)', () => {
    const r = checkOrigin('http://127.0.0.1:3000/form', ['127.0.0.1']);
    expect(r.outcome).toBe('pass');
    expect(r.registrableDomain).toBeNull();
    expect(checkOrigin('http://localhost/x', ['localhost']).outcome).toBe('pass');
    expect(checkOrigin('http://localhost/x', ['*.localhost']).outcome).toBe('fail');
  });
});

describe('checkOrigin — wildcard (registrable domain)', () => {
  it('matches any subdomain and the apex', () => {
    for (const url of [
      'https://linkedin.com/',
      'https://www.linkedin.com/',
      'https://m.linkedin.com/feed',
      'https://api.gateway.linkedin.com/',
    ]) {
      expect(checkOrigin(url, ['*.linkedin.com']).outcome).toBe('pass');
    }
  });

  it('is spoof-proof against sibling and suffix attacks', () => {
    expect(checkOrigin('https://evil-linkedin.com/', ['*.linkedin.com']).outcome).toBe('fail');
    expect(checkOrigin('https://linkedin.com.attacker.com/', ['*.linkedin.com']).outcome).toBe(
      'fail',
    );
    expect(checkOrigin('https://notlinkedin.com/', ['*.linkedin.com']).outcome).toBe('fail');
  });

  it('handles multi-label public suffixes (eTLD+1)', () => {
    expect(checkOrigin('https://shop.example.co.uk/', ['*.example.co.uk']).outcome).toBe('pass');
    expect(checkOrigin('https://example.co.uk/', ['*.example.co.uk']).outcome).toBe('pass');
    expect(checkOrigin('https://evil.co.uk/', ['*.example.co.uk']).outcome).toBe('fail');
  });
});

describe('checkOrigin — optional path glob', () => {
  it('host-only pattern still matches ANY path', () => {
    for (const url of [
      'https://linkedin.com/',
      'https://linkedin.com/login',
      'https://linkedin.com/login/extra',
      'https://linkedin.com/a/b/c?q=1#frag',
    ]) {
      const r = checkOrigin(url, ['linkedin.com']);
      expect(r.outcome).toBe('pass');
      expect(r.matchedPath).toBe(null);
    }
  });

  it('exact path glob matches only that exact pathname', () => {
    const r = checkOrigin('https://linkedin.com/login', ['linkedin.com/login']);
    expect(r.outcome).toBe('pass');
    expect(r.matchedPattern).toBe('linkedin.com/login');
    expect(r.matchedPath).toBe('/login');
    expect(checkOrigin('https://linkedin.com/login/extra', ['linkedin.com/login']).outcome).toBe(
      'fail',
    );
    expect(checkOrigin('https://linkedin.com/login?next=1', ['linkedin.com/login']).outcome).toBe(
      'pass',
    );
  });

  it('path glob is CASE-SENSITIVE', () => {
    expect(checkOrigin('https://LinkedIn.com/login', ['linkedin.com/login']).outcome).toBe('pass');
    expect(checkOrigin('https://linkedin.com/Login', ['linkedin.com/login']).outcome).toBe('fail');
    expect(checkOrigin('https://linkedin.com/LOGIN', ['linkedin.com/login']).outcome).toBe('fail');
  });

  it("'*' admits a run of chars and '?' exactly one", () => {
    expect(
      checkOrigin('https://linkedin.com/login/anything/here', ['linkedin.com/login/*']).outcome,
    ).toBe('pass');
    expect(checkOrigin('https://linkedin.com/login', ['linkedin.com/login*']).outcome).toBe('pass');
    expect(checkOrigin('https://linkedin.com/loginX', ['linkedin.com/login?']).outcome).toBe(
      'pass',
    );
    expect(checkOrigin('https://linkedin.com/login', ['linkedin.com/login?']).outcome).toBe('fail');
  });

  it('wildcard host + path glob: both parts must hold', () => {
    for (const url of [
      'https://app.example.com/app/dashboard',
      'https://www.example.com/app/',
      'https://example.com/app/x/y',
    ]) {
      expect(checkOrigin(url, ['*.example.com/app/*']).outcome).toBe('pass');
    }
    expect(checkOrigin('https://app.example.com/other', ['*.example.com/app/*']).outcome).toBe(
      'fail',
    );
  });

  it('a path pattern still FAILS when the host fails', () => {
    expect(checkOrigin('https://evil-linkedin.com/login', ['*.linkedin.com/login']).outcome).toBe(
      'fail',
    );
    expect(
      checkOrigin('https://linkedin.com.attacker.com/login', ['*.linkedin.com/login']).outcome,
    ).toBe('fail');
    expect(checkOrigin('https://www.linkedin.com/login', ['linkedin.com/login']).outcome).toBe(
      'fail',
    );
  });

  it('bad scheme still fails regardless of the path glob', () => {
    for (const url of ['file:///login', 'javascript:/login', 'ftp://linkedin.com/login']) {
      const r = checkOrigin(url, ['linkedin.com/login', '*.linkedin.com/*']);
      expect(r.outcome).toBe('fail');
      expect(['bad_scheme', 'no_host']).toContain(r.reason ?? '');
    }
  });

  it('multiple patterns: a host match with a path miss falls through to a later match', () => {
    const r = checkOrigin('https://linkedin.com/feed', ['linkedin.com/login', 'linkedin.com/feed']);
    expect(r.outcome).toBe('pass');
    expect(r.matchedPattern).toBe('linkedin.com/feed');
  });
});

describe('checkOrigin — empty / malformed', () => {
  it('empty allow-list never matches', () => {
    expect(checkOrigin('https://linkedin.com/', []).outcome).toBe('fail');
    expect(checkOrigin('https://linkedin.com/', []).reason).toBe('not_allowed');
  });
  it('malformed URL fails closed', () => {
    expect(checkOrigin('not a url', ['linkedin.com']).outcome).toBe('fail');
    expect(checkOrigin('not a url', ['linkedin.com']).reason).toBe('no_host');
    expect(isUrlAllowed('', ['linkedin.com'])).toBe(false);
  });
  it('ignores blank patterns', () => {
    expect(checkOrigin('https://linkedin.com/', ['', '   ', 'linkedin.com']).outcome).toBe('pass');
  });
  it('a bare "*." pattern never matches', () => {
    expect(checkOrigin('https://linkedin.com/', ['*.']).outcome).toBe('fail');
  });
});

describe('domainKey / pageScope / originsFromUris', () => {
  it('reads the registrable domain of a URL or bare host, else the hostname', () => {
    expect(domainKey('https://www.github.com/login?token=abc')).toBe('github.com');
    expect(domainKey('github.com')).toBe('github.com');
    expect(domainKey('sub.example.co.uk')).toBe('example.co.uk');
    expect(domainKey('http://127.0.0.1:8080/x')).toBe('127.0.0.1');
    expect(domainKey('localhost')).toBe('localhost');
    expect(domainKey('')).toBeNull();
    expect(domainKey('not a url')).toBeNull();
  });

  it('scopes only http(s) pages', () => {
    expect(pageScope('https://www.github.com/login')).toEqual({
      host: 'www.github.com',
      key: 'github.com',
    });
    expect(pageScope('about:blank')).toBeNull();
    expect(pageScope('file:///tmp/x')).toBeNull();
    expect(pageScope('nonsense')).toBeNull();
  });

  it('derives exact lowercase hosts from login uris, treating schemeless as https and skipping non-http', () => {
    expect(hostFromUri('GitHub.com/login')).toBe('github.com');
    expect(hostFromUri('androidapp://com.example')).toBeUndefined();
    expect(hostFromUri('   ')).toBeUndefined();
    expect(
      originsFromUris(['https://a.example', 'a.example', 'ssh://x', 'https://B.example/x']),
    ).toEqual(['a.example', 'b.example']);
  });
});

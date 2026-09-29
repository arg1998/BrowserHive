/** @module app/notifications/public-url.test — the `publicUrl` check outcomes (spec 08 §5.8), the checker's cache, the host/origin helpers and the link builders (D-37). */
import { describe, expect, it } from 'bun:test';
import type { UrlProbeResult } from '../../ports/notification-channel.ts';
import { createLocalLinkBuilder, createPublicLinkBuilder, linkBuilderFor } from './links.ts';
import {
  classifyPublicUrlProbe,
  isInsecurePublicUrl,
  PublicUrlChecker,
  publicUrlHost,
  publicUrlOrigin,
} from './public-url.ts';

const json = (status: number, body: unknown): UrlProbeResult => ({
  kind: 'response',
  status,
  contentType: 'application/json',
  location: null,
  body: JSON.stringify(body),
});
const health = (id?: string) => ({
  status: 'ready',
  version: '0.2.0',
  ...(id !== undefined && { instance_id: id }),
});

describe('classifyPublicUrlProbe', () => {
  it('ok when this instance answers, elsewhere when another one does', () => {
    expect(classifyPublicUrlProbe(json(200, health('me')), 'me').outcome).toBe('ok');
    expect(classifyPublicUrlProbe(json(503, health('me')), 'me').outcome).toBe('ok');
    expect(classifyPublicUrlProbe(json(200, health('other')), 'me').outcome).toBe('elsewhere');
    expect(classifyPublicUrlProbe(json(200, health()), 'me').outcome).toBe('elsewhere');
  });

  it('without a running server a BrowserHive answer is ok but unconfirmed', () => {
    const verdict = classifyPublicUrlProbe(json(200, health('x')), null);
    expect(verdict.outcome).toBe('ok');
    expect(verdict.detail).toContain('confirm');
  });

  it('login for redirects, 401/403/407 and HTML pages', () => {
    const redirect: UrlProbeResult = {
      kind: 'response',
      status: 302,
      contentType: null,
      location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login',
      body: '',
    };
    expect(classifyPublicUrlProbe(redirect, 'me')).toMatchObject({
      outcome: 'login',
      statusCode: 302,
    });
    expect(classifyPublicUrlProbe(redirect, 'me').detail).toContain('team.cloudflareaccess.com');
    for (const status of [401, 403, 407]) {
      expect(classifyPublicUrlProbe(json(status, {}), 'me').outcome).toBe('login');
    }
    const html: UrlProbeResult = {
      kind: 'response',
      status: 200,
      contentType: 'text/html; charset=utf-8',
      location: null,
      body: '<html>Sign in</html>',
    };
    expect(classifyPublicUrlProbe(html, 'me').outcome).toBe('login');
    // A proxy's error page is not a login: the proxy cannot reach BrowserHive.
    for (const status of [502, 503, 504]) {
      const verdict = classifyPublicUrlProbe({ ...html, status }, 'me');
      expect(verdict.outcome).toBe('unreachable');
      expect(verdict.detail).toContain(`HTTP ${status}`);
    }
  });

  it('unreachable for network errors, elsewhere for other servers', () => {
    const verdict = classifyPublicUrlProbe({ kind: 'error', detail: 'ECONNREFUSED' }, 'me');
    expect(verdict.outcome).toBe('unreachable');
    expect(verdict.detail).toContain('hairpin');
    expect(classifyPublicUrlProbe(json(404, { error: 'nope' }), 'me').outcome).toBe('elsewhere');
  });
});

describe('PublicUrlChecker', () => {
  it('reports unset without probing', async () => {
    let probes = 0;
    const checker = new PublicUrlChecker({
      publicUrl: undefined,
      localUrl: () => 'http://127.0.0.1:9876',
      instanceId: 'me',
      probe: async () => {
        probes++;
        return json(200, health('me'));
      },
      clock: { now: () => 0, sleep: async () => undefined },
    });
    expect(await checker.status(true)).toMatchObject({
      configured: false,
      outcome: 'unset',
      url: null,
      local_url: 'http://127.0.0.1:9876',
      host_trusted: false,
    });
    expect(probes).toBe(0);
  });

  it('probes <publicUrl>/health, caches a minute, refreshes on demand', async () => {
    let now = 1_000;
    const urls: string[] = [];
    const checker = new PublicUrlChecker({
      publicUrl: 'https://bh.example.net',
      localUrl: () => 'http://127.0.0.1:9876',
      instanceId: 'me',
      probe: async (url) => {
        urls.push(url);
        return json(200, health('me'));
      },
      clock: { now: () => now, sleep: async () => undefined },
    });
    expect(await checker.status()).toMatchObject({ outcome: 'ok', checked_at: 1_000 });
    now += 30_000;
    await checker.status();
    expect(urls).toEqual(['https://bh.example.net/health']);
    await checker.status(true);
    now += 61_000;
    await checker.status();
    expect(urls).toHaveLength(3);
  });

  it('turns a throwing probe into unreachable', async () => {
    const checker = new PublicUrlChecker({
      publicUrl: 'https://bh.example.net',
      localUrl: () => 'x',
      instanceId: 'me',
      probe: async () => {
        throw new Error('boom');
      },
      clock: { now: () => 0, sleep: async () => undefined },
    });
    expect((await checker.status()).outcome).toBe('unreachable');
  });
});

describe('host, origin and links', () => {
  it('extracts the trusted host and origin', () => {
    expect(publicUrlHost('https://BH.example.net:8443/bh')).toBe('bh.example.net');
    expect(publicUrlHost('http://[::1]:9876')).toBe('::1');
    expect(publicUrlOrigin('https://bh.example.net:8443/bh')).toBe('https://bh.example.net:8443');
    expect(publicUrlHost(undefined)).toBeNull();
  });

  it('warns about plain http on a public host only', () => {
    expect(isInsecurePublicUrl('http://bh.example.net')).toBe(true);
    expect(isInsecurePublicUrl('http://localhost:9876')).toBe(false);
    expect(isInsecurePublicUrl('https://bh.example.net')).toBe(false);
    expect(isInsecurePublicUrl(undefined)).toBe(false);
  });

  it('builds public links under a path prefix, local ones against the listener', () => {
    expect(createPublicLinkBuilder('https://bh.example.net/bh').url('/sessions/x?live=1')).toBe(
      'https://bh.example.net/bh/sessions/x?live=1',
    );
    const local = createLocalLinkBuilder(() => 'http://127.0.0.1:9876/');
    expect(local.local).toBe(true);
    expect(local.url('/notifications')).toBe('http://127.0.0.1:9876/notifications');
    expect(linkBuilderFor('https://a.example.net', () => 'x').local).toBe(false);
    expect(linkBuilderFor(undefined, () => 'http://h').url('/p')).toBe('http://h/p');
  });
});

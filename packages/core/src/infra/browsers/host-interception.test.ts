/** @module infra/browsers/host-interception.test — the self-origin guard and the owner of a request on a template host. */

import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page, Request } from 'playwright';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { createCollectingLogger } from '../logging/collecting-logger.ts';
import { hostOwnerResolver, originOf, selfOriginHandler } from './host-interception.ts';
import { PARKED, sessionOwner } from './page-attribution.ts';
import { applyTemplatePreferences, mergePreferences } from './profile-preferences.ts';

function request(input: {
  url?: string;
  page?: Page | 'unattached' | 'none';
  serviceWorker?: boolean;
}): Request {
  return {
    url: () => input.url ?? 'https://site-a.test/',
    serviceWorker: () => (input.serviceWorker === true ? {} : null),
    isNavigationRequest: () => input.page === 'unattached',
    frame: () => {
      if (input.page === 'unattached' || input.page === 'none' || input.page === undefined)
        throw new Error('no frame');
      const page = input.page;
      return { page: () => page };
    },
  } as unknown as Request;
}

const CONTEXT = {
  owner: async () => ({ kind: 'host' as const }),
  signal: () => new AbortController().signal,
};

describe('self-origin guard', () => {
  const guard = selfOriginHandler({
    origins: ['http://127.0.0.1:9876', 'http://localhost:9876', 'https://hive.example.com/'],
    logger: createCollectingLogger(),
  });

  it('aborts every request to BrowserHive origins and passes the rest', async () => {
    for (const url of [
      'http://127.0.0.1:9876/',
      'http://LOCALHOST:9876/api/v1/x',
      'https://hive.example.com/dashboard',
    ]) {
      expect(await guard.handle(request({ url }), CONTEXT)).toEqual({
        kind: 'abort',
        reason: 'blockedbyclient',
      });
    }
    for (const url of ['http://127.0.0.1:9877/', 'https://site-a.test/', 'data:text/html,x']) {
      expect(await guard.handle(request({ url }), CONTEXT)).toEqual({ kind: 'pass' });
    }
  });

  it('fails closed when the request cannot be read', async () => {
    const broken = {
      url: () => {
        throw new Error('gone');
      },
    } as unknown as Request;
    expect(await guard.handle(broken, CONTEXT)).toEqual({ kind: 'abort', reason: 'failed' });
    expect(guard.id).toBe('self-origin');
  });

  it('normalizes origins', () => {
    expect(originOf('HTTPS://Hive.Example.com:443/x')).toBe('https://hive.example.com');
    expect(originOf('about:blank')).toBeNull();
  });
});

describe('owner of a request on a template host', () => {
  const owners = new Map<Page, ReturnType<typeof sessionOwner> | typeof PARKED>();
  const a = {} as Page;
  const parked = {} as Page;
  const held = {} as Page;
  owners.set(a, sessionOwner('s-a'));
  owners.set(parked, PARKED);

  it('a page request → its attribution; parked, service worker or no page → the host', async () => {
    const clock = new FakeClock();
    const resolve = hostOwnerResolver({
      attribution: { attributionOf: (p) => owners.get(p) },
      clock,
    });
    expect(await resolve(request({ page: a }))).toEqual({ kind: 'session', sessionId: 's-a' });
    expect(await resolve(request({ page: parked }))).toEqual({ kind: 'host' });
    expect(await resolve(request({ page: a, serviceWorker: true }))).toEqual({ kind: 'host' });
    expect(await resolve(request({ page: 'none' }))).toEqual({ kind: 'host' });
  });

  it('a frameless navigation is held until its page is attributed, at most the hold', async () => {
    const clock = new FakeClock();
    let frame: Page | 'unattached' = 'unattached';
    const live = {
      get page() {
        return frame;
      },
    };
    const resolve = hostOwnerResolver({
      attribution: { attributionOf: (p) => owners.get(p) },
      clock,
    });
    const pending = resolve(request(live as never));
    await clock.advance(100);
    frame = held;
    await clock.advance(100);
    owners.set(held, sessionOwner('s-b'));
    await clock.advance(100);
    expect(await pending).toEqual({ kind: 'session', sessionId: 's-b' });
    const never = resolve(request({ page: 'unattached' }));
    await clock.advance(2_100);
    expect(await never).toEqual({ kind: 'host' });
  });
});

describe('profile preferences', () => {
  it('deep-merges and keeps unrelated keys', () => {
    expect(
      mergePreferences(
        { profile: { name: 'x', exit_type: 'Crashed' }, a: 1 },
        { profile: { exit_type: 'Normal' } },
      ),
    ).toEqual({
      profile: { name: 'x', exit_type: 'Normal' },
      a: 1,
    });
  });

  it('writes the template preferences into Default/Preferences, replacing a corrupt file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bh-prefs-'));
    await mkdir(join(dir, 'Default'), { recursive: true });
    await writeFile(join(dir, 'Default', 'Preferences'), '{not json');
    await applyTemplatePreferences(dir);
    const prefs = JSON.parse(await readFile(join(dir, 'Default', 'Preferences'), 'utf8'));
    expect(prefs).toMatchObject({
      credentials_enable_service: false,
      profile: { password_manager_enabled: false, exited_cleanly: true },
      autofill: { profile_enabled: false, credit_card_enabled: false },
      signin: { allowed: false },
      session: { restore_on_startup: 5 },
    });
  });
});

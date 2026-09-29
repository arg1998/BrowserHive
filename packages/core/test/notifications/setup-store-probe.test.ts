/** @module test/notifications/setup-store-probe.test — the Telegram connect calls against the fake Bot API, the screenshot store on a temp dir (0600 files, refs validated before any path is built, pruning) and the `publicUrl` probe (spec 03 §4.8.1, §9.5; spec 08 §5.8). */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createNotificationImageStore,
  createTelegramSetup,
  createUrlProbe,
} from '../../src/infra/notifications/index.ts';
import { isStartCommand } from '../../src/infra/notifications/telegram-setup.ts';
import { FAKE_TG_TOKEN, FakePlatforms } from '../helpers/fake-platforms.ts';
import { withTempDir } from '../helpers/temp-dir.ts';
import { JPEG } from './helpers.ts';

let fakes: FakePlatforms;
beforeEach(() => {
  fakes = new FakePlatforms().start();
});
afterEach(async () => {
  await fakes.stop();
});

describe('telegram setup', () => {
  it('reads the bot username', async () => {
    const setup = createTelegramSetup({ apiBase: fakes.telegramBase });
    expect(await setup.botUsername(FAKE_TG_TOKEN)).toBe('bh_test_bot');
  });

  it('refuses a bad token with auth and without echoing it', async () => {
    fakes.script('telegram:getMe', {
      status: 401,
      body: { ok: false, description: 'Unauthorized' },
    });
    const setup = createTelegramSetup({ apiBase: fakes.telegramBase });
    const err = await setup.botUsername(FAKE_TG_TOKEN).catch((e: Error & { code?: string }) => e);
    expect((err as { code?: string }).code).toBe('auth');
    expect((err as Error).message).not.toContain(FAKE_TG_TOKEN);
  });

  it('captures the chat and the sender of /start <code> in a group topic', async () => {
    fakes.updates.push(
      {
        update_id: 10,
        message: { message_id: 1, text: 'hello', chat: { id: 5, type: 'private' } },
      },
      {
        update_id: 11,
        message: {
          message_id: 2,
          text: '/start@bh_test_bot c0de123',
          chat: { id: -1009, type: 'supergroup', title: 'Ops' },
          from: { id: 77, first_name: 'Amir', last_name: 'G' },
          message_thread_id: 3,
          is_topic_message: true,
        },
      },
    );
    const setup = createTelegramSetup({ apiBase: fakes.telegramBase });
    const start = await setup.waitForStart(FAKE_TG_TOKEN, 'c0de123', {
      signal: new AbortController().signal,
      deadline: Date.now() + 5_000,
    });
    expect(start).toEqual({
      chat: { id: '-1009', title: 'Ops', type: 'supergroup', threadId: '3' },
      user: { id: '77', name: 'Amir G' },
    });
    const polls = fakes.of('telegram').filter((r) => r.path === 'getUpdates');
    expect(polls.at(-1)?.json).toMatchObject({ offset: 12 });
  });

  it('gives up at the deadline and on abort', async () => {
    const setup = createTelegramSetup({ apiBase: fakes.telegramBase });
    expect(
      await setup.waitForStart(FAKE_TG_TOKEN, 'nope', {
        signal: new AbortController().signal,
        deadline: Date.now() + 200,
      }),
    ).toBeNull();
    const controller = new AbortController();
    controller.abort();
    expect(
      await setup.waitForStart(FAKE_TG_TOKEN, 'nope', {
        signal: controller.signal,
        deadline: Date.now() + 5_000,
      }),
    ).toBeNull();
  });

  it('matches only the exact code', () => {
    expect(isStartCommand('/start abc', 'abc')).toBe(true);
    expect(isStartCommand('/start@bot abc', 'abc')).toBe(true);
    expect(isStartCommand('/start abcd', 'abc')).toBe(false);
    expect(isStartCommand('start abc', 'abc')).toBe(false);
  });
});

describe('image store', () => {
  it('stores 0600 files, reads them back, refuses traversal and prunes old ones', async () => {
    await withTempDir(async (root) => {
      const dir = join(root, 'notifications', 'images');
      const store = createNotificationImageStore(dir);
      const ref = await store.put({ bytes: JPEG, contentType: 'image/jpeg', filename: 'x.jpg' });
      expect(ref).toMatch(/^nimg-[A-Za-z0-9_-]{16}$/);
      expect((await store.read(ref))?.bytes).toEqual(JPEG);
      expect((await stat(join(dir, `${ref}.jpg`))).mode & 0o777).toBe(0o600);
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
      expect(await store.read('../../etc/passwd')).toBeNull();
      expect(await store.read('nimg-doesnotexist12')).toBeNull();
      expect(await store.prune(Date.now() - 60_000)).toBe(0);
      expect(await store.prune(Date.now() + 60_000)).toBe(1);
      expect(await store.read(ref)).toBeNull();
    });
  });
});

describe('url probe', () => {
  it('reports answers, redirects without following them, and errors', async () => {
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req) =>
        new URL(req.url).pathname === '/health'
          ? Response.json({ status: 'ready', instance_id: 'i-1' })
          : Response.redirect('https://login.example.com/', 302),
    });
    try {
      const probe = createUrlProbe();
      const ok = await probe(`http://127.0.0.1:${server.port}/health`, 2_000);
      expect(ok).toMatchObject({ kind: 'response', status: 200 });
      expect(ok.kind === 'response' && JSON.parse(ok.body)).toEqual({
        status: 'ready',
        instance_id: 'i-1',
      });
      const moved = await probe(`http://127.0.0.1:${server.port}/other`, 2_000);
      expect(moved).toMatchObject({
        kind: 'response',
        status: 302,
        location: 'https://login.example.com/',
      });
      expect((await probe('http://127.0.0.1:1/health', 2_000)).kind).toBe('error');
    } finally {
      await server.stop(true);
    }
  });
});

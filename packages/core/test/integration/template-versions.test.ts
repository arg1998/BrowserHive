/// <reference lib="dom" />
/** @module test/integration/template-versions.test — versions, encryption at rest, restore and seeding on a real template host (spec 13 §2.4, §3.9, §3.12, §7.4; §17 T1b acceptance), both drivers: version 1 encrypted (no cookie name in the file, bound to key, header and slot), rolling cookies writing no version, a disappearing sign-in cookie writing `signin_change`, a localStorage sign-in surviving a restart, a checkpoint and a restore, restore as an operation that closes sessions and leaves no plaintext, seeding to `ready`, and a missing key leaving the host running. */

import { afterEach, describe, expect, it } from 'bun:test';
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { TemplateHostOperations } from '../../src/app/templates/host-operations.ts';
import { TemplateOperations } from '../../src/app/templates/template-operations.ts';
import { TemplateService } from '../../src/app/templates/template-service.ts';
import { TemplateStateService } from '../../src/app/templates/template-state.ts';
import type { Session } from '../../src/domain/session/session.ts';
import { templateKeyOf } from '../../src/domain/templates/envelope.ts';
import { createSystemClock } from '../../src/infra/clock/system-clock.ts';
import { createTemplateFiles } from '../../src/infra/fs/template-files.ts';
import { FileTemplateStateStore } from '../../src/infra/fs/template-state-store.ts';
import { createCollectingLogger } from '../../src/infra/logging/collecting-logger.ts';
import { isAppError } from '../../src/kernel/errors/app-error.ts';
import type { TemplateKeyRing } from '../../src/ports/template-state.ts';
import { FakeIdGenerator } from '../helpers/fake-id-generator.ts';
import { InMemoryRepositories, InMemoryUnitOfWork } from '../helpers/in-memory-repos.ts';
import { InMemoryOperatorActionRepository } from '../helpers/in-memory-vault-repos.ts';
import { FAKE_TEMPLATE_GEO, RecordingDegradations } from '../helpers/template-kit.ts';
import { templateSiteRecord } from '../persistence/helpers.ts';
import {
  type DriverName,
  HEADED,
  type TemplateWorld,
  templateWorld,
  until,
} from './template-fixture.ts';

const DRIVERS: readonly DriverName[] = ['playwright', 'patchright'];
const KEY = templateKeyOf(new Uint8Array(32).fill(42));
/** A localStorage-held sign-in (the token value is long enough to be recognisable). */
const LOCAL_TOKEN = 'local-sign-in-token-0123456789';

let world: TemplateWorld | null = null;
afterEach(async () => {
  await world?.stop();
  world = null;
});

/** The T1b services over the world's real supervisor, with in-memory rows. */
async function services(
  w: TemplateWorld,
  keys: TemplateKeyRing = { current: KEY, previous: null },
) {
  const repos = Object.assign(new InMemoryRepositories(), {
    operatorActions: new InMemoryOperatorActionRepository(),
  });
  await repos.templates.insert(w.template);
  await repos.templateSites.upsert(
    templateSiteRecord({ templateId: w.template.templateId, learnedCookieNames: ['sid'] }),
  );
  const store = new FileTemplateStateStore({ templatesDir: join(w.dataDir, 'templates'), keys });
  const clock = createSystemClock();
  const logger = createCollectingLogger();
  const degradations = new RecordingDegradations();
  const state = new TemplateStateService({
    repos,
    store,
    hostOf: (id) => w.supervisor.runningHost(id),
    clock,
    logger,
    degradations,
    config: { checkpointIntervalMs: 60_000, versionsKeep: 10 },
  });
  w.supervisor.attachCheckpoints(state);
  const ops = new TemplateHostOperations({
    supervisor: w.supervisor,
    sessions: w.sessions,
    launcher: {},
    dataDir: w.dataDir,
    logger,
    clock,
    drainTimeoutMs: 5_000,
  });
  const operations = new TemplateOperations({
    repos,
    ops,
    state,
    ids: new FakeIdGenerator(),
    clock,
    logger,
  });
  return { repos, store, state, ops, operations, degradations };
}

/** The agent page of a session. */
function pageOf(session: Session): Page {
  const page = session.view?.page;
  if (page === undefined) throw new Error('no page');
  return page;
}

/** Signs in on site-a: a `sid` cookie and a localStorage token, as a site's own scripts would. */
async function signIn(page: Page, sid: string): Promise<void> {
  await page.goto('https://site-a.test/landing');
  await page.evaluate(
    ([value, token]) => {
      // biome-ignore lint/suspicious/noDocumentCookie: the site's own script sets its sign-in cookie
      document.cookie = `sid=${value}; Max-Age=86400; Path=/; Secure; SameSite=Lax`;
      localStorage.setItem('auth', token);
    },
    [sid, LOCAL_TOKEN] as const,
  );
}

async function storage(page: Page): Promise<{ cookie: string; token: string | null }> {
  await page.goto('https://site-a.test/landing');
  return await page.evaluate(() => ({
    cookie: document.cookie,
    token: localStorage.getItem('auth'),
  }));
}

/** Every file under `dir` (recursively), as paths. */
async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) out.push(join(entry.parentPath, entry.name));
  }
  return out;
}

for (const driver of DRIVERS) {
  describe(`template versions (${driver}${HEADED ? ', headed' : ''})`, () => {
    it('writes version 1 encrypted, bound to the key, the header and the slot', async () => {
      world = await templateWorld(driver);
      const w = world;
      const { state, store } = await services(w);
      await signIn(pageOf(await w.launch('alpha')), 'first-session-value-000');
      expect(
        await state.saveVersion(w.template.templateId, { reason: 'recording', by: 'operator' }),
      ).toBe(1);
      const dir = join(w.dataDir, 'templates', w.template.templateId, 'versions');
      const bytes = await readFile(join(dir, 'v1.state.enc'));
      for (const clear of ['sid', 'auth', LOCAL_TOKEN, 'first-session-value-000', 'site-a.test']) {
        expect(bytes.includes(Buffer.from(clear))).toBe(false);
      }
      const read = await store.read(w.template.templateId, 1);
      expect(read.cookies.some((c) => c.name === 'sid')).toBe(true);
      // Another key, a swapped slot and an altered header all fail.
      const stranger = new FileTemplateStateStore({
        templatesDir: join(w.dataDir, 'templates'),
        keys: { current: templateKeyOf(new Uint8Array(32).fill(1)), previous: null },
      });
      const unreadable = async (p: Promise<unknown>) =>
        p.then(
          () => 'read',
          (e: unknown) => (isAppError(e) ? e.code : String(e)),
        );
      expect(await unreadable(stranger.read(w.template.templateId, 1))).toBe(
        'TEMPLATE_VERSION_UNREADABLE',
      );
      await writeFile(join(dir, 'latest.state.enc'), bytes);
      expect(await unreadable(store.read(w.template.templateId, 'latest'))).toBe(
        'TEMPLATE_VERSION_UNREADABLE',
      );
      const altered = Buffer.from(bytes);
      altered[4] = 1;
      altered[6] = (altered[6] ?? 0) ^ 0xff;
      await writeFile(join(dir, 'v1.state.enc'), altered);
      expect(await unreadable(store.read(w.template.templateId, 1))).toBe(
        'TEMPLATE_VERSION_UNREADABLE',
      );
    });

    it('rolling cookies write no version; a disappearing sign-in cookie writes signin_change; a localStorage sign-in survives a restart, a checkpoint and a restore', async () => {
      world = await templateWorld(driver);
      const w = world;
      const id = w.template.templateId;
      const { state, store, operations, repos } = await services(w);
      const alpha = await w.launch('alpha');
      await signIn(pageOf(alpha), 'value-one-00000000000');
      expect(await state.saveVersion(id, { reason: 'recording', by: 'operator' })).toBe(1);
      // The site rolls its cookie: same name, new value.
      await pageOf(alpha).evaluate(() => {
        // biome-ignore lint/suspicious/noDocumentCookie: the site's own script sets its sign-in cookie
        document.cookie = 'sid=value-two-00000000000; Max-Age=86400; Path=/; Secure; SameSite=Lax';
      });
      expect(await state.checkpoint(id)).toEqual({ written: true, version: null });
      // A new browser process that never visits the site: the checkpoint carries its storage.
      await w.supervisor.stopHost(id, 'test restart');
      const bravo = await w.launch('bravo');
      expect(await state.checkpoint(id)).toEqual({ written: true, version: null });
      const latest = await store.read(id, 'latest');
      expect(
        latest.origins.find((o) => o.origin === 'https://site-a.test')?.localStorage,
      ).toContainEqual({ name: 'auth', value: LOCAL_TOKEN });
      // The sign-in cookie disappears: a version records the change.
      await pageOf(bravo).goto('https://site-a.test/landing');
      await pageOf(bravo).evaluate(() => {
        // biome-ignore lint/suspicious/noDocumentCookie: the site's own script sets its sign-in cookie
        document.cookie = 'sid=; Max-Age=0; Path=/; Secure; SameSite=Lax';
        localStorage.removeItem('auth');
      });
      expect(await state.checkpoint(id)).toEqual({ written: true, version: 2 });
      expect((await repos.templateVersions.get(id, 2))?.reason).toBe('signin_change');
      // Restore version 1 as an operation: the session closes, the sign-in comes back.
      const { operation_id } = await operations.restore(id, 1, {
        forceClose: true,
        by: 'operator',
      });
      await until(() => operations.get(operation_id).state !== 'running', 60_000, 'restore');
      const op = operations.get(operation_id);
      expect(op).toMatchObject({ state: 'done', version: 3 });
      expect(op.closed_sessions).toContain(bravo.id);
      expect(w.sessions.peek(bravo.id)).toBeUndefined();
      expect((await repos.templateVersions.get(id, 3))?.restoredFrom).toBe(1);
      const charlie = await w.launch('charlie');
      const after = await storage(pageOf(charlie));
      expect(after.token).toBe(LOCAL_TOKEN);
      expect(after.cookie).toContain('sid=value-one-00000000000');
      // No plaintext state anywhere outside the browser's own profile.
      for (const path of await files(w.dataDir)) {
        if (path.includes(`${join('templates', id, 'userdata')}`)) continue;
        const content = await readFile(path).catch(() => Buffer.alloc(0));
        expect(content.includes(Buffer.from(LOCAL_TOKEN))).toBe(false);
      }
    });

    it('a delete waits out a running restore, and a delete that slipped past leaves no browser and no profile (review #79 H-1)', async () => {
      world = await templateWorld(driver);
      const w = world;
      const id = w.template.templateId;
      const { state, operations, repos, ops } = await services(w);
      const service = new TemplateService({
        repos,
        uow: new InMemoryUnitOfWork(repos),
        runtime: w.supervisor,
        ops,
        geo: FAKE_TEMPLATE_GEO,
        files: createTemplateFiles(join(w.dataDir, 'templates')),
        degradations: new RecordingDegradations(),
        ids: new FakeIdGenerator(),
        clock: createSystemClock(),
        logger: createCollectingLogger(),
        config: {
          enabled: true,
          authMode: 'off',
          maxPagesPerHost: 40,
          defaults: { channel: 'chromium', stealth: 'off', fingerprint: false, humanize: false },
        },
      });
      await signIn(pageOf(await w.launch('alpha')), 'restored-secret-0000000');
      expect(await state.saveVersion(id, { reason: 'recording', by: 'operator' })).toBe(1);
      // A restore that waits for alpha; the delete is refused meanwhile.
      const first = await operations.restore(id, 1, { forceClose: false, by: 'operator' });
      const refused = await service.remove(id, { force: true, by: 'operator' }).then(
        () => 'deleted',
        (e: unknown) => (isAppError(e) ? e.code : String(e)),
      );
      expect(refused).toBe('CONFLICT');
      await until(() => operations.get(first.operation_id).state !== 'running', 60_000, 'restore');
      // A delete that bypassed the hold (defence in depth): the supervisor forgets the id first.
      const dir = join(w.dataDir, 'templates', id);
      await w.launch('bravo');
      const second = await operations.restore(id, 1, { forceClose: false, by: 'operator' });
      await w.supervisor.shutdown(id);
      await repos.templates.remove(id);
      await rm(dir, { recursive: true, force: true });
      await until(() => operations.get(second.operation_id).state !== 'running', 60_000, 'restore');
      expect(operations.get(second.operation_id).state).toBe('failed');
      expect(w.supervisor.runningHost(id)).toBeNull();
      expect(
        await stat(join(dir, 'userdata')).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
    });

    it('seeds a template from a storage state to ready; a missing key leaves the host running', async () => {
      world = await templateWorld(driver);
      const w = world;
      const id = w.template.templateId;
      const { operations, repos } = await services(w);
      await repos.templates.update(id, { status: 'recording' });
      const { operation_id } = await operations.seed(
        id,
        {
          cookies: [
            {
              name: 'sid',
              value: 'seeded-value-00000000',
              domain: 'site-a.test',
              path: '/',
              expires: -1,
              httpOnly: false,
              secure: true,
              sameSite: 'Lax',
            },
          ],
          origins: [
            { origin: 'https://site-a.test', localStorage: [{ name: 'auth', value: LOCAL_TOKEN }] },
          ],
        },
        { confirm: false, by: 'operator' },
      );
      await until(() => operations.get(operation_id).state !== 'running', 60_000, 'seed');
      expect(operations.get(operation_id)).toMatchObject({ state: 'done', version: 1 });
      expect((await repos.templates.get(id))?.status).toBe('ready');
      expect((await repos.templateVersions.get(id, 1))?.reason).toBe('import');
      const seeded = await storage(pageOf(await w.launch('alpha')));
      expect(seeded.cookie).toContain('sid=seeded-value-00000000');
      expect(seeded.token).toBe(LOCAL_TOKEN);
      // Without a key: checkpoints are skipped, and the browser keeps serving sessions.
      const keyless = await services(w, { current: null, previous: null });
      expect(await keyless.state.checkpoint(id)).toEqual({ written: false, why: 'no_key' });
      const bravo = await w.launch('bravo');
      await pageOf(bravo).goto('https://site-a.test/landing');
      expect(w.supervisor.host(id).state).toBe('running');
    });
  });
}

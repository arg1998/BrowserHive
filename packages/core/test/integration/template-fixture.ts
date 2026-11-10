/** @module test/integration/template-fixture — a real template host per test: the HTTPS fixture sites, a temporary data dir, the Playwright driver, a `SessionService` and the host supervisor; launches go through the template branch of the pipeline. */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { InProcessEventBus } from '../../src/app/events/bus.ts';
import type { DomainEvents } from '../../src/app/events/catalog.ts';
import { SessionService } from '../../src/app/sessions/session-service.ts';
import { TemplateHostSupervisor } from '../../src/app/templates/host-supervisor.ts';
import type { Session } from '../../src/domain/session/session.ts';
import { PlaywrightBrowserDriver } from '../../src/infra/browsers/playwright-browser-driver.ts';
import type { PlaywrightTemplateHost } from '../../src/infra/browsers/template-host.ts';
import { createSystemClock } from '../../src/infra/clock/system-clock.ts';
import { createCollectingLogger } from '../../src/infra/logging/collecting-logger.ts';
import { removeTree } from '../../src/kernel/remove.ts';
import type { TemplateRecord } from '../../src/ports/persistence/index.ts';
import type { TemplateHostSpec } from '../../src/ports/template-host.ts';
import { FakeIdGenerator } from '../helpers/fake-id-generator.ts';
import { type HttpsSites, startHttpsSites } from '../helpers/https-sites.ts';
import { RecordingDegradations } from '../helpers/template-kit.ts';
import { templateRecord, templateSiteRecord } from '../persistence/helpers.ts';
import { HOST } from './driver-fixture.ts';

/** Which driver a template host runs on in a suite. */
export type DriverName = 'playwright' | 'patchright';

/**
 * Headed hosts run where a display is meant for tests: Linux CI under `xvfb-run -a` sets
 * `BROWSERHIVE_TEMPLATES_HEADED=1`. Elsewhere hosts are headless (spec 13 §3.11).
 */
export const HEADED = process.env['BROWSERHIVE_TEMPLATES_HEADED'] === '1';

/** One test's world. */
export interface TemplateWorld {
  readonly sites: HttpsSites;
  readonly sessions: SessionService;
  readonly supervisor: TemplateHostSupervisor;
  readonly template: TemplateRecord;
  readonly degradations: RecordingDegradations;
  /** Every host the supervisor started, oldest first. */
  readonly hosts: PlaywrightTemplateHost[];
  launch(slug: string): Promise<Session>;
  /** The newest host. */
  host(): PlaywrightTemplateHost;
  stop(): Promise<void>;
}

/** Builds a world for `driver`; `maxPagesPerHost` bounds agent pages. */
export async function templateWorld(
  driver: DriverName,
  options: { readonly maxPagesPerHost?: number; readonly selfOrigins?: readonly string[] } = {},
): Promise<TemplateWorld> {
  const sites = startHttpsSites();
  const dataDir = await mkdtemp(join(tmpdir(), 'bh-tpl-'));
  const clock = createSystemClock();
  const logger = createCollectingLogger();
  const bus = new InProcessEventBus<DomainEvents>({ clock, logger });
  const real = new PlaywrightBrowserDriver({ logger, clock, host: HOST, stealthDriver: driver });
  const hosts: PlaywrightTemplateHost[] = [];
  const launcher = {
    async launchTemplateHost(spec: TemplateHostSpec) {
      const host = (await real.launchTemplateHost(spec)) as PlaywrightTemplateHost;
      hosts.push(host);
      return host;
    },
  };
  const sessions = new SessionService({
    clock,
    ids: new FakeIdGenerator(),
    logger,
    bus,
    driver: real,
    proxyResolver: { resolve: async (r) => r.requested },
    config: {
      dataDir,
      sessionLease: 3_600_000,
      sessionCloseTimeout: 10_000,
      defaultHeadless: true,
      defaultChannel: 'chromium',
      persistence: 'memory',
      maxSessions: 4,
      stealth: 'off',
      stealthDriver: driver,
      fingerprint: false,
      humanize: false,
      trace: false,
      screenshotTrace: false,
    },
  });
  const degradations = new RecordingDegradations();
  const supervisor = new TemplateHostSupervisor({
    launcher,
    sessions,
    templates: {
      update: async (id, patch) => templateRecord({ templateId: id, ...patch }),
      touchLastUsed: async () => undefined,
    },
    clock,
    logger,
    degradations,
    spec: {
      dataDir,
      stealthDriver: driver,
      proxyResolver: { resolve: async (r) => r.requested },
      env: {},
      selfOrigins: () => options.selfOrigins ?? [],
      testingArgs: sites.chromiumArgs,
    },
    config: {
      idleTimeoutMs: 0,
      recycleAfterMs: 0,
      drainTimeoutMs: 10_000,
      maxPagesPerHost: options.maxPagesPerHost ?? 40,
      closeTimeoutMs: 10_000,
    },
  });
  const template = templateRecord({
    headless: !HEADED,
    stealth: driver === 'patchright' ? 'standard' : 'off',
    maxConcurrent: 5,
  });
  const site = templateSiteRecord();
  return {
    sites,
    sessions,
    supervisor,
    template,
    degradations,
    hosts,
    launch: (slug) =>
      supervisor.launch({
        template,
        sites: [site],
        slug,
        connectionId: null,
        client: null,
        principal: { subject: 'agent' },
        sealing: {
          hideCookieValues: true,
          forceDisableEvaluate: true,
          refuseCookieWrites: true,
          refuseStateExport: true,
        },
        sealed: true,
        settings: {
          channel: 'chromium',
          headless: template.headless,
          stealth: template.stealth !== 'off',
          fingerprint: false,
          humanize: false,
          disableEvaluate: true,
          incognito: false,
          persistenceMode: 'memory',
          vaultEnabled: false,
          contextOptions: {},
        },
      }),
    host: () => {
      const host = hosts.at(-1);
      if (host === undefined) throw new Error('no host');
      return host;
    },
    async stop() {
      await sessions.closeAll('shutdown', 10_000);
      await supervisor.stopAll();
      sites.stop();
      await removeTree(dataDir).catch(() => undefined);
    },
  };
}

/** Waits until `predicate` holds (polling), or fails after `ms`. */
export async function until(
  predicate: () => boolean,
  ms = 5_000,
  what = 'condition',
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** The URLs of a session's tabs, in tab order. */
export function tabUrls(session: Session): string[] {
  return session.tabs.entries().map(([, page]) => page.url());
}

/** Clicks an element whose handler may close its own page. */
export async function clickClosing(page: Page, selector: string): Promise<void> {
  await page.click(selector, { noWaitAfter: true }).catch(() => undefined);
}

/** @module test/integration/template-mcp-fixture — the real MCP stack over a real template host: the tool harness (dispatcher, policies, sealing) with a `TemplateHostSupervisor` on the driver (Patchright) and the HTTPS fixture sites. */

import {
  type HostSupervisorDeps,
  TemplateHostSupervisor,
} from '../../src/app/templates/host-supervisor.ts';
import { PlaywrightBrowserDriver } from '../../src/infra/browsers/playwright-browser-driver.ts';
import { createSystemClock } from '../../src/infra/clock/system-clock.ts';
import { createCollectingLogger } from '../../src/infra/logging/collecting-logger.ts';
import type {
  TemplateRecord,
  TemplateSiteRecord,
  TemplateUnsealRecord,
} from '../../src/ports/persistence/index.ts';
import type { ToolHarness, ToolHarnessOptions } from '../helpers/fake-transport.ts';
import { type HttpsSites, startHttpsSites } from '../helpers/https-sites.ts';
import { RecordingDegradations } from '../helpers/template-kit.ts';
import { templateRecord, templateSiteRecord } from '../persistence/helpers.ts';
import { HOST } from './driver-fixture.ts';
import { createRealHarness } from './mcp-fixture.ts';
import { HEADED, type StealthLeg } from './template-fixture.ts';

/** A BrowserHive origin the `#browserhive` refusal knows (nothing listens there). */
export const SELF_ORIGIN = 'http://127.0.0.1:9';

/** One test's MCP world. */
export interface TemplateMcp {
  readonly harness: ToolHarness;
  readonly sites: HttpsSites;
  readonly supervisor: TemplateHostSupervisor;
  readonly template: TemplateRecord;
  /** The real driver (site-pack enforcement arms its template hosts). */
  readonly driver: PlaywrightBrowserDriver;
  stop(): Promise<void>;
}

/** Options of {@link templateMcp}. */
export interface TemplateMcpOptions {
  readonly unseal?: Partial<TemplateUnsealRecord>;
  readonly sites?: readonly Partial<TemplateSiteRecord>[];
  /** Map the challenge providers' hosts to the fixture (site pack challenges). */
  readonly providers?: boolean;
  /** Site pack enforcement on the tool path. */
  readonly siteGuards?: ToolHarnessOptions['siteGuards'];
  /** Passed to the tool harness (the security intercepts' tool hold). */
  readonly siteHolds?: ToolHarnessOptions['siteHolds'];
  /** Before-action strategies of site packs (spec 13 §9.4). */
  readonly siteActions?: ToolHarnessOptions['siteActions'];
  readonly transport?: ToolHarnessOptions['transport'];
  /** Supervisor collaborators: the site packs of the admission strategies, the jitter source. */
  readonly supervisor?: Pick<HostSupervisorDeps, 'sitePacks' | 'random'>;
  /** The host spec's pack switches (`webrtc-policy`, T3b). */
  readonly hostFlags?: (template: TemplateRecord) => Promise<readonly string[]>;
}

/** A ready template `job-hunt` on site-a.test (and the given sites) behind the real tool stack. */
export async function templateMcp(
  stealth: StealthLeg,
  options: TemplateMcpOptions = {},
): Promise<TemplateMcp> {
  const sites = startHttpsSites({ providers: options.providers === true });
  const clock = createSystemClock();
  const real = new PlaywrightBrowserDriver({
    logger: createCollectingLogger(),
    clock,
    host: HOST,
    testingArgs: sites.chromiumArgs,
  });
  let harness: ToolHarness | null = null;
  const repos = () => {
    if (harness === null) throw new Error('harness not ready');
    return harness.templates.repos;
  };
  const built: { supervisor: TemplateHostSupervisor | null } = { supervisor: null };
  harness = await createRealHarness({
    driver: real,
    vault: true,
    ...(options.siteHolds !== undefined && { siteHolds: options.siteHolds }),
    ...(options.transport !== undefined && { transport: options.transport }),
    selfOrigins: [SELF_ORIGIN],
    ...(options.siteGuards !== undefined && { siteGuards: options.siteGuards }),
    ...(options.siteActions !== undefined && { siteActions: options.siteActions }),
    templateRuntime: (sessions, dataDir) => {
      const supervisor = new TemplateHostSupervisor({
        launcher: real,
        sessions,
        templates: {
          update: (id, patch, ifVersion) => repos().templates.update(id, patch, ifVersion),
          touchLastUsed: (id, at) => repos().templates.touchLastUsed(id, at),
        },
        clock,
        logger: createCollectingLogger(),
        degradations: new RecordingDegradations(),
        spec: {
          dataDir,
          proxyResolver: { resolve: async (r) => r.requested },
          env: {},
          selfOrigins: () => [SELF_ORIGIN],
          testingArgs: sites.chromiumArgs,
          ...(options.hostFlags !== undefined && { hostFlags: options.hostFlags }),
        },
        config: {
          idleTimeoutMs: 0,
          recycleAfterMs: 0,
          drainTimeoutMs: 10_000,
          maxPagesPerHost: 40,
          closeTimeoutMs: 10_000,
        },
        ...options.supervisor,
      });
      built.supervisor = supervisor;
      return supervisor;
    },
  });
  const template = templateRecord({
    headless: !HEADED,
    stealth,
    unseal: {
      cookieValues: false,
      evaluate: false,
      cookieWrites: false,
      stateExport: false,
      principals: null,
      ...options.unseal,
    },
  });
  await harness.templates.repos.templates.insert(template);
  for (const site of options.sites ?? [{ siteId: 'site-a.test' }]) {
    await harness.templates.repos.templateSites.upsert(
      templateSiteRecord({ templateId: template.templateId, ...site }),
    );
  }
  const supervisor = built.supervisor;
  if (supervisor === null) throw new Error('supervisor not built');
  const ready = harness;
  return {
    harness: ready,
    sites,
    supervisor,
    template,
    driver: real,
    async stop() {
      try {
        await ready.close({ beforeRemove: () => supervisor.stopAll() });
      } catch (err) {
        // Windows: a just-closed Chromium can hold a file of the temp data dir for a while (EBUSY);
        // a leftover temp dir is not this suite's failure.
        const code = (err as { code?: unknown } | null)?.code;
        if (process.platform !== 'win32' || code !== 'EBUSY') throw err;
      } finally {
        sites.stop();
      }
    },
  };
}

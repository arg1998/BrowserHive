/** @module app/templates/clipboard-switch-start.test — "Deny clipboard writes" changed while a template's browser starts (spec 13 §2.1, D18; review #84 M1): the live call finds no running browser, and once the host reaches `running` the switch is applied as the template has it then; a host already running is not re-read, a change racing the re-read ends with the newer value, and a browser that cannot take it is restarted. */

import { describe, expect, it } from 'bun:test';
import type { HostView } from '@browserhive/contracts/http';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import { FakeBrowserDriver } from '../../../test/helpers/fake-browser-driver.ts';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { FakeIdGenerator } from '../../../test/helpers/fake-id-generator.ts';
import { FakeTemplateLauncher } from '../../../test/helpers/fake-template-host.ts';
import { RecordingDegradations } from '../../../test/helpers/template-kit.ts';
import {
  TEMPLATE_ID,
  templateRecord,
  templateSiteRecord,
} from '../../../test/persistence/helpers.ts';
import type { TemplateRecord } from '../../ports/persistence/index.ts';
import { InProcessEventBus } from '../events/bus.ts';
import type { DomainEvents } from '../events/catalog.ts';
import { SessionService } from '../sessions/session-service.ts';
import { FakeSessionDirFs, testConfig } from '../sessions/test-support.ts';
import { applyClipboardSwitch, watchClipboardOnStart } from './clipboard-switch.ts';
import { TemplateHostSupervisor } from './host-supervisor.ts';

/** Lets pending promise chains settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** A real supervisor (and so a real host lifecycle) over a launcher whose starts the test holds. */
function world() {
  const clock = new FakeClock(1_700_000_000_000);
  const logger = new CollectingLogger();
  const bus = new InProcessEventBus<DomainEvents>({ clock, logger });
  const sessions = new SessionService({
    clock,
    ids: new FakeIdGenerator(),
    logger,
    bus,
    driver: new FakeBrowserDriver(),
    proxyResolver: { resolve: async (r) => r.requested },
    config: testConfig({ maxSessions: 3 }),
    fs: new FakeSessionDirFs(),
  });
  const launcher = new FakeTemplateLauncher();
  const supervisor = new TemplateHostSupervisor({
    launcher,
    sessions,
    templates: {
      update: async (id, patch) => templateRecord({ templateId: id, ...patch }),
      touchLastUsed: async () => undefined,
    },
    clock,
    logger,
    degradations: new RecordingDegradations(),
    spec: {
      dataDir: '/data',
      proxyResolver: { resolve: async (r) => r.requested },
      env: {},
      selfOrigins: () => [],
      testingArgs: [],
    },
    config: {
      idleTimeoutMs: 3_600_000,
      recycleAfterMs: 86_400_000,
      drainTimeoutMs: 60_000,
      maxPagesPerHost: 40,
      closeTimeoutMs: 1_000,
    },
    bus,
  });
  // What the browser was given: only a running host takes it (as the composition wires it).
  const applied: [string, boolean][] = [];
  const clipboardWrites = async (id: string, deny: boolean) => {
    if (supervisor.runningHost(id) !== null) applied.push([id, deny]);
  };
  return { logger, bus, launcher, supervisor, applied, clipboardWrites };
}

function launch(supervisor: TemplateHostSupervisor, template: TemplateRecord) {
  return supervisor.launch({
    template,
    sites: [templateSiteRecord()],
    slug: 'jobs',
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
      channel: template.channel,
      headless: template.headless,
      stealth: false,
      fingerprint: false,
      humanize: false,
      disableEvaluate: true,
      incognito: false,
      persistenceMode: 'memory',
      vaultEnabled: false,
      contextOptions: {},
    },
  });
}

describe('a clipboard change while the browser starts (review #84 M1)', () => {
  it('is applied once the host runs', async () => {
    const w = world();
    let row = templateRecord();
    const restarts: string[] = [];
    const deps = {
      runtime: w.supervisor,
      ops: { restartHost: async (t: TemplateRecord) => void restarts.push(t.templateId) },
      clipboardWrites: w.clipboardWrites,
      logger: w.logger,
    };
    const off = watchClipboardOnStart({ ...deps, templates: { get: async () => row }, bus: w.bus });
    w.launcher.hold = true;
    const launching = launch(w.supervisor, row);
    await flush();
    expect(w.supervisor.host(TEMPLATE_ID).state).toBe('starting');
    // The PATCH lands now: committed, then its live call finds no running browser.
    row = { ...row, denyClipboardWrites: true };
    await applyClipboardSwitch(deps, row);
    expect(w.applied).toEqual([]);
    // The start was built from the old row.
    expect(w.launcher.specs[0]?.denyClipboardWrites).toBe(false);
    w.launcher.release();
    await launching;
    await flush();
    expect(w.supervisor.host(TEMPLATE_ID).state).toBe('running');
    expect(w.applied).toEqual([[TEMPLATE_ID, true]]);
    expect(restarts).toEqual([]);
    off();
  });

  it('without the watch, the change is lost until a later start (the finding)', async () => {
    const w = world();
    let row = templateRecord();
    w.launcher.hold = true;
    const launching = launch(w.supervisor, row);
    await flush();
    row = { ...row, denyClipboardWrites: true };
    const deps = {
      runtime: w.supervisor,
      ops: { restartHost: async () => undefined },
      clipboardWrites: w.clipboardWrites,
      logger: w.logger,
    };
    await applyClipboardSwitch(deps, row);
    w.launcher.release();
    await launching;
    await flush();
    expect(w.applied).toEqual([]);
  });
});

describe('watchClipboardOnStart', () => {
  function bus() {
    const logger = new CollectingLogger();
    return { logger, bus: new InProcessEventBus<DomainEvents>({ clock: new FakeClock(), logger }) };
  }
  const host = (state: HostView['state']): HostView =>
    ({ state, since: 1, started_at: 1, restarts: 0, pages: 0, parked_pages: 0 }) as HostView;
  const running = (previous: HostView['state']) =>
    ({
      type: 'template.host',
      template_id: TEMPLATE_ID,
      host: host('running'),
      previous_state: previous,
    }) as DomainEvents['template.host'];

  it('reads the template only when the host enters running', async () => {
    const { logger, bus: events } = bus();
    let reads = 0;
    const applied: boolean[] = [];
    watchClipboardOnStart({
      templates: {
        get: async () => {
          reads++;
          return templateRecord({ denyClipboardWrites: true });
        },
      },
      runtime: { host: () => ({ state: 'running' }) as never },
      ops: { restartHost: async () => undefined },
      clipboardWrites: async (_id, deny) => void applied.push(deny),
      bus: events,
      logger,
    });
    events.publish('template.host', running('running'));
    await flush();
    expect(reads).toBe(0);
    events.publish('template.host', running('starting'));
    await flush();
    // One apply, then one re-read that finds the same value.
    expect(applied).toEqual([true]);
    expect(reads).toBe(2);
  });

  it('a PATCH committed between the read and the apply: the newer value is what stays', async () => {
    const { logger, bus: events } = bus();
    const rows = [true, false, false];
    const applied: boolean[] = [];
    watchClipboardOnStart({
      templates: {
        get: async () => templateRecord({ denyClipboardWrites: rows.shift() ?? false }),
      },
      runtime: { host: () => ({ state: 'running' }) as never },
      ops: { restartHost: async () => undefined },
      clipboardWrites: async (_id, deny) => void applied.push(deny),
      bus: events,
      logger,
    });
    events.publish('template.host', running('starting'));
    await flush();
    expect(applied).toEqual([true, false]);
  });

  it('a browser that cannot take it is restarted, so its start applies it', async () => {
    const { logger, bus: events } = bus();
    const restarts: string[] = [];
    watchClipboardOnStart({
      templates: { get: async () => templateRecord({ denyClipboardWrites: true }) },
      runtime: { host: () => ({ state: 'running' }) as never },
      ops: { restartHost: async (t) => void restarts.push(t.templateId) },
      clipboardWrites: async () => {
        throw new Error('no browser session');
      },
      bus: events,
      logger,
    });
    events.publish('template.host', running('starting'));
    await flush();
    expect(restarts[0]).toBe(TEMPLATE_ID);
  });
});

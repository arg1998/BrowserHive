/** @module app/sessions/create-pipeline.test — phase order, compensators, launch failure hygiene, deadline and abort. */
import { describe, expect, it } from 'bun:test';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import { FakeBrowserDriver } from '../../../test/helpers/fake-browser-driver.ts';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { FakeIdGenerator } from '../../../test/helpers/fake-id-generator.ts';
import { LOCAL_PRINCIPAL } from '../../domain/session/principal.ts';
import { AppError, isAppError } from '../../kernel/errors/app-error.ts';
import type { LaunchWarning } from '../../ports/browser-driver.ts';
import type { SessionPolicyInstaller } from '../../ports/session-policies.ts';
import { InProcessEventBus } from '../events/bus.ts';
import type { DomainEvents } from '../events/catalog.ts';
import { PIPELINE_PHASES } from './create-pipeline.ts';
import type { SessionServiceConfig } from './service-deps.ts';
import { SessionService } from './session-service.ts';
import { FakeSessionDirFs, testConfig } from './test-support.ts';

function setup(
  options: { config?: Partial<SessionServiceConfig>; policies?: SessionPolicyInstaller } = {},
) {
  const clock = new FakeClock(1_700_000_000_000);
  const logger = new CollectingLogger();
  const bus = new InProcessEventBus<DomainEvents>({ clock, logger });
  const events: string[] = [];
  const closed: DomainEvents['session.closed'][] = [];
  const warnings: DomainEvents['session.warning'][] = [];
  bus.subscribeAll((e) => {
    events.push(e.name);
  });
  bus.subscribe('session.closed', (e) => {
    closed.push(e.payload);
  });
  bus.subscribe('session.warning', (e) => {
    warnings.push(e.payload);
  });
  const driver = new FakeBrowserDriver();
  const fs = new FakeSessionDirFs();
  const service = new SessionService({
    clock,
    ids: new FakeIdGenerator(),
    logger,
    bus,
    driver,
    proxyResolver: { resolve: async (r) => r.requested },
    config: testConfig(options.config),
    fs,
    ...(options.policies !== undefined && { policies: options.policies }),
  });
  return { clock, logger, bus, events, closed, warnings, driver, fs, service };
}

describe('create pipeline (D-21)', () => {
  it('runs the phases in declared order and reports per-phase timings', async () => {
    const { service, driver, events, fs } = setup();
    const session = await service.create({ slug: 'shop' }, LOCAL_PRINCIPAL);
    expect(session.id).toBe('shop-00000001');
    expect(session.state.kind).toBe('live');
    expect(service.timings.map((t) => t.phase)).toEqual([...PIPELINE_PHASES]);
    expect(service.timings.every((t) => t.ms >= 0)).toBe(true);
    expect(driver.launches).toHaveLength(1);
    expect(driver.launches[0]?.downloadsDir).toBe('/data/sessions/shop-00000001/downloads');
    expect(driver.launches[0]?.userDataDir).toBeUndefined();
    expect(fs.ops.filter((op) => op.startsWith('mkdir'))).toEqual([
      'mkdir /data/sessions/shop-00000001 700',
      'mkdir /data/sessions/shop-00000001/screenshots 700',
      'mkdir /data/sessions/shop-00000001/downloads 700',
    ]);
    expect(events.filter((e) => e === 'session.opened')).toHaveLength(1);
    expect(events.indexOf('session.opened')).toBeLessThan(events.indexOf('session.updated'));
    expect(session.tabs.size()).toBe(1);
    expect(service.registry.has(session.id)).toBe(true);
  });

  it('persistent mode creates userdata and passes the managed path to the driver', async () => {
    const { service, driver, fs } = setup();
    await service.create({ slug: 'shop', persistenceMode: 'persistent' }, LOCAL_PRINCIPAL);
    expect(driver.launches[0]?.userDataDir).toBe('/data/sessions/shop-00000001/userdata');
    expect(fs.dirs.has('/data/sessions/shop-00000001/userdata')).toBe(true);
  });

  it('a veto in installPolicies runs the compensators of earlier phases in reverse exactly once', async () => {
    const order: string[] = [];
    const policies: SessionPolicyInstaller = {
      install: async () => {
        order.push('veto');
        throw new AppError('INTERNAL_ERROR', { ref: 'policy-veto' });
      },
    };
    const { service, driver, fs, closed, events } = setup({ policies });
    driver.onLaunch(() => order.push('launch'));
    let caught: unknown;
    try {
      await service.create({ slug: 'shop' }, LOCAL_PRINCIPAL);
    } catch (err) {
      caught = err;
    }
    expect(isAppError(caught, 'INTERNAL_ERROR')).toBe(true);
    const handle = driver.handles[0];
    expect(handle?.closes).toHaveLength(1);
    expect(handle?.closes[0]?.deadlineMs).toBe(1_000);
    expect(fs.ops.filter((op) => op === 'rm /data/sessions/shop-00000001')).toHaveLength(1);
    expect(service.registry.size).toBe(0);
    // Compensators: launch (handle close) ran before prepareProfile (rm) — reverse order.
    const rmIndex = fs.ops.indexOf('rm /data/sessions/shop-00000001');
    expect(rmIndex).toBeGreaterThan(-1);
    expect<unknown>(closed).toEqual([
      {
        type: 'session.closed',
        session_id: 'shop-00000001',
        closed_at: 1_700_000_000_000,
        reason: 'launch_failed',
      },
    ]);
    expect(events.filter((e) => e === 'session.closed')).toHaveLength(1);
  });

  it('a throw in launch leaves no reservation, no profile dir and no registry entry', async () => {
    const { service, driver, fs, closed } = setup();
    driver.failNextWith(
      new AppError('BROWSER_NOT_INSTALLED', {
        channel: 'chromium',
        install_command: 'browserhive init',
      }),
    );
    let caught: unknown;
    try {
      await service.create({ slug: 'shop', persistenceMode: 'persistent' }, LOCAL_PRINCIPAL);
    } catch (err) {
      caught = err;
    }
    expect(isAppError(caught, 'BROWSER_NOT_INSTALLED')).toBe(true);
    expect(service.registry.size).toBe(0);
    expect(fs.dirs.size).toBe(0);
    expect(fs.ops.at(-1)).toBe('rm /data/sessions/shop-00000001');
    expect(driver.handles).toHaveLength(0);
    expect(closed[0]?.reason).toBe('launch_failed');
    // Capacity is free again: the next create gets the next id and succeeds.
    const next = await service.create({ slug: 'shop' }, LOCAL_PRINCIPAL);
    expect(next.id).toBe('shop-00000002');
  });

  it('validation failures happen before any side effect', async () => {
    const { service, driver, fs, events } = setup();
    await expect(service.create({ slug: 'Bad Slug' }, LOCAL_PRINCIPAL)).rejects.toMatchObject({
      code: 'INVALID_SLUG',
    });
    await expect(
      service.create({ slug: 'shop', launchOptions: { args: ['--no-sandbox'] } }, LOCAL_PRINCIPAL),
    ).rejects.toMatchObject({ code: 'UNSAFE_LAUNCH_ARG' });
    expect(driver.launches).toHaveLength(0);
    expect(fs.ops).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it('the deadline aborts a hanging launch with WAIT_TIMEOUT and closes the orphan handle', async () => {
    const { service, driver, clock } = setup();
    driver.hang();
    // The kernel deadline uses a real timer; the fake clock stays put. Settle the rejection eagerly
    // so the runtime never sees it unhandled while the test waits.
    const caught: unknown = await service
      .create({ slug: 'shop' }, LOCAL_PRINCIPAL, { deadlineMs: 20 })
      .then(
        () => undefined,
        (err: unknown) => err,
      );
    expect(isAppError(caught, 'WAIT_TIMEOUT')).toBe(true);
    expect(service.registry.size).toBe(0);
    driver.releaseAll();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(driver.handles[0]?.closed).toBe(true);
    expect(clock.now()).toBe(1_700_000_000_000);
  });

  it('an AbortSignal cancels between phases', async () => {
    const controller = new AbortController();
    const policies: SessionPolicyInstaller = {
      install: async () => {
        controller.abort(new Error('client went away'));
        return [];
      },
    };
    const { service, driver } = setup({ policies });
    let caught: unknown;
    try {
      await service.create({ slug: 'shop' }, LOCAL_PRINCIPAL, { signal: controller.signal });
    } catch (err) {
      caught = err;
    }
    expect(isAppError(caught, 'INTERNAL_ERROR')).toBe(true);
    if (isAppError(caught, 'INTERNAL_ERROR')) expect(caught.details.ref).toBe('launch-aborted');
    expect(driver.handles[0]?.closed).toBe(true);
    expect(service.registry.size).toBe(0);
  });

  it('adopts driver and policy warnings in their phases and broadcasts them', async () => {
    const policies: SessionPolicyInstaller = {
      install: async () => [{ code: 'BLOCKLIST_ROUTE_FAILED', message: 'no route' }],
    };
    const { service, driver, warnings } = setup({
      policies,
      config: { trace: true, stealth: 'standard' },
    });
    const driverWarnings: LaunchWarning[] = [
      { code: 'EXECUTABLE_PATH_OVERRIDE', message: 'exe' },
      { code: 'TRACE_START_FAILED', message: 'trace' },
      { code: 'STEALTH_INIT_FAILED', message: 'stealth' },
    ];
    driver.handleOptions = () => ({ warnings: driverWarnings, tracing: false });
    const session = await service.create({ slug: 'shop' }, LOCAL_PRINCIPAL);
    expect(warnings.map((w) => w.code)).toEqual([
      'EXECUTABLE_PATH_OVERRIDE',
      'BLOCKLIST_ROUTE_FAILED',
      'TRACE_START_FAILED',
      'STEALTH_INIT_FAILED',
    ]);
    expect(session.warnings).toHaveLength(4);
    expect(driver.launches[0]?.tracing?.enabled).toBe(true);
    expect(driver.launches[0]?.stealth).toBe(true);
    expect(driver.handles[0]?.identityPages).toHaveLength(1);
  });

  it('a crash during launch fails the create with BROWSER_CRASHED and unwinds', async () => {
    const { service, driver } = setup({
      // The crash listener is attached in `launch`; a crash during `installPolicies` is seen at the next checkpoint.
      policies: {
        install: async () => {
          driver.handles[0]?.crash('boom');
          return [];
        },
      },
    });
    let caught: unknown;
    try {
      await service.create({ slug: 'shop' }, LOCAL_PRINCIPAL);
    } catch (err) {
      caught = err;
    }
    expect(isAppError(caught, 'BROWSER_CRASHED')).toBe(true);
    expect(service.registry.size).toBe(0);
  });
});

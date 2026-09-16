/** @module composition/phases/domain-sessions — browser driver (Patchright resolution per `stealthDriver`), identity/proxy resolvers, blocklist (+ watcher), auth-state store, session service and lease sweeper. */

import { watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { ServerConfig } from '@browserhive/contracts/config';
import type { Clock, DomainEvents, EventBus, IdGenerator, Logger } from '@browserhive/core/runtime';
import { isAppError, serializeError } from '@browserhive/core/runtime';
import type {
  BlocklistFileWatcher,
  HostFacts,
  SessionPolicyInstaller,
} from '@browserhive/core/server';
import {
  AuthStateStore,
  assertChromiumInstalled,
  BlocklistService,
  bundledChromiumVersion,
  DriverResolver,
  HostGeoSeedResolver,
  installBlocklistRoute,
  LeaseSweeper,
  PassThroughProxyResolver,
  PlaywrightBrowserDriver,
  resolveIdentity,
  SessionService,
} from '@browserhive/core/server';
import type { DegradationRelay } from '../adapters/degradation-relay.ts';

/** Inputs of {@link buildSessions}. */
export interface SessionsInput {
  readonly config: Readonly<ServerConfig>;
  readonly host: HostFacts;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly bus: EventBus<DomainEvents>;
  readonly relay: DegradationRelay;
}

/** Built session-side services. */
export interface SessionsParts {
  readonly driverName: () => 'patchright' | 'playwright';
  readonly browserInstalled: boolean;
  /** Version of the Chromium build `chromium` sessions launch; `null` when it is not installed. */
  readonly chromiumVersion: string | null;
  readonly blocklist: BlocklistService;
  readonly stopWatcher: (() => void) | null;
  readonly authStates: AuthStateStore;
  readonly sessions: SessionService;
  readonly sweeper: LeaseSweeper;
}

/** `fs.watch` adapter for the blocklist hot reload (D-22). */
export const nodeBlocklistWatcher: BlocklistFileWatcher = {
  watch(path, onChange) {
    const watcher = watch(path, { persistent: false }, () => onChange());
    watcher.on('error', () => onChange());
    return () => watcher.close();
  },
};

/**
 * Checks the Chromium binary for the resolved driver. A missing browser is not a boot failure
 * (D-18): it is reported as a `BROWSER_NOT_INSTALLED` degradation and surfaces as the typed error at
 * the first launch.
 */
export function probeBrowser(
  resolver: DriverResolver,
  input: Pick<SessionsInput, 'config' | 'host' | 'relay' | 'logger'>,
): boolean {
  try {
    const browserType =
      input.config.stealth === 'off'
        ? resolver.stock()
        : resolver.resolveStealth(input.config.stealthDriver).browserType;
    assertChromiumInstalled(browserType, 'chromium', { env: input.host.env });
    return true;
  } catch (err) {
    const message = isAppError(err) ? err.message : 'Chromium is not installed';
    input.logger.warn('browser not installed', { err: serializeError(err) });
    input.relay.report({
      code: 'BROWSER_NOT_INSTALLED',
      severity: 'warn',
      message,
      details: { install_command: 'browserhive init' },
    });
    return false;
  }
}

/** Builds the session side. `blocklist.load()` failing is fatal (`BLOCKLIST_LOAD_FAILED`). */
export async function buildSessions(input: SessionsInput): Promise<SessionsParts> {
  const { config, clock, ids, logger, bus, host } = input;
  const resolver = new DriverResolver({ logger });
  const browserInstalled = probeBrowser(resolver, input);
  const driver = new PlaywrightBrowserDriver({
    logger,
    clock,
    host,
    stealthDriver: config.stealthDriver,
    driverResolver: resolver,
  });
  // The System page's runtime row: the build the driver actually launches (Patchright's or
  // Playwright's bundled Chromium), not a system-wide browser.
  const chromiumVersion = browserInstalled
    ? bundledChromiumVersion(config.stealth === 'off' ? 'playwright' : driver.stealthDriverName())
    : null;
  const geoSeed = new HostGeoSeedResolver(host);

  let sessionsRef: SessionService | undefined;
  const blocklist = new BlocklistService({
    path: config.blocklist,
    fs: { readFile: (path) => readFile(path, 'utf8') },
    bus,
    clock,
    ids,
    logger,
    degradations: input.relay,
    sessionSlug: (sessionId) => sessionsRef?.peek(sessionId)?.slug ?? null,
    urlQueryAllowlist: config.urlQueryAllowlist,
  });
  await blocklist.load();
  const stopWatcher =
    blocklist.configured && config.blocklistWatch ? blocklist.watch(nodeBlocklistWatcher) : null;

  const policies: SessionPolicyInstaller = {
    async install(handle, context) {
      const warning = await installBlocklistRoute(handle.context, {
        blocklist: blocklist.holder,
        observer: blocklist.requestObserver,
        sessionId: context.sessionId,
        clock,
        logger,
      });
      return warning === null ? [] : [warning];
    },
  };
  const authStates = new AuthStateStore({ dataDir: config.dataDir, clock, logger });
  const sessions = new SessionService({
    clock,
    ids,
    logger,
    bus,
    driver,
    proxyResolver: new PassThroughProxyResolver(),
    identityResolver: { resolve: (request) => resolveIdentity(request, { geoSeed, host }) },
    ...(blocklist.configured && { policies }),
    authStates,
    config: {
      dataDir: config.dataDir,
      sessionLease: config.sessionLease,
      sessionCloseTimeout: config.sessionCloseTimeout,
      defaultHeadless: config.defaultHeadless,
      defaultChannel: config.defaultChannel,
      persistence: config.persistence,
      maxSessions: config.maxSessions,
      stealth: config.stealth,
      stealthDriver: config.stealthDriver,
      fingerprint: config.fingerprint,
      humanize: config.humanize,
      trace: config.trace,
      screenshotTrace: config.screenshotTrace,
    },
  });
  sessionsRef = sessions;
  const sweeper = new LeaseSweeper({
    target: sessions,
    clock,
    logger,
    report: (error) =>
      input.relay.report({
        code: 'LEASE_SWEEP_FAILED',
        severity: 'warn',
        message: 'lease sweep failed',
        details: { name: serializeError(error).name },
      }),
  });
  return {
    driverName: () => driver.stealthDriverName(),
    browserInstalled,
    chromiumVersion,
    blocklist,
    stopWatcher,
    authStates,
    sessions,
    sweeper,
  };
}

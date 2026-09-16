/** @module infra/browsers/playwright-browser-driver — the BrowserDriver adapter: launch pipeline for memory/storage-state/persistent, identity, tracing, capabilities (spec 11 §2). */

import type { StealthDriver } from '@browserhive/contracts/enums';
import type { Browser, BrowserContext, BrowserContextOptions, BrowserType, Page } from 'playwright';
import { AppError, isAppError } from '../../kernel/errors/app-error.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type {
  AppliedDisplay,
  AppliedIdentity,
  BrowserDriver,
  EngineCapabilities,
  LaunchSpec,
  LaunchWarning,
  SessionHandle,
} from '../../ports/browser-driver.ts';
import type { Clock } from '../../ports/clock.ts';
import type { Logger } from '../../ports/logger.ts';
import { ATTR, SPAN, withSpan } from '../telemetry/spans.ts';
import { launchKwargsForChannel } from './channel.ts';
import {
  assertChromiumInstalled,
  browserNotInstalledFromLaunchError,
  type ChromiumResolverDeps,
} from './chromium-resolver.ts';
import { DriverResolver } from './driver-resolver.ts';
import { contextOptionsFor, scriptPayloadFor } from './fingerprint.ts';
import type { HostFacts } from './host-facts.ts';
import { IdentityApplier } from './identity-applier.ts';
import { buildLaunchOptions, executablePathWarning } from './launch-args.ts';
import { installNativeGetters, mergeNativeGetterPayloads } from './native-getter.ts';
import { PlaywrightSessionHandle } from './session-handle.ts';
import { deviceMemoryPayload } from './stealth-identity.ts';
import { PlaywrightTracingHandle, traceStartWarning } from './tracing.ts';

/** Constructor dependencies of {@link PlaywrightBrowserDriver}. */
export interface PlaywrightBrowserDriverDeps {
  readonly logger: Logger;
  readonly clock: Clock;
  readonly host: HostFacts;
  /** The configured `stealthDriver` mode, reported by {@link PlaywrightBrowserDriver.stealthDriverName}. */
  readonly stealthDriver: StealthDriver;
  /** Test seam; defaults to a fresh {@link DriverResolver} over the real packages. */
  readonly driverResolver?: DriverResolver;
  /** Test seam for the binary pre-check. */
  readonly chromium?: Omit<ChromiumResolverDeps, 'env'>;
}

/**
 * Production driver: spawns a real Playwright (or Patchright) Chromium driver per session via
 * `browserType.launch(...)`. One browser subprocess + one context per session is the isolation
 * primitive; nothing here is shared between launches.
 */
export class PlaywrightBrowserDriver implements BrowserDriver {
  private readonly logger: Logger;
  private readonly clock: Clock;
  private readonly host: HostFacts;
  private readonly mode: StealthDriver;
  private readonly resolver: DriverResolver;
  private readonly chromiumDeps: ChromiumResolverDeps;

  constructor(deps: PlaywrightBrowserDriverDeps) {
    this.logger = deps.logger.child({ module: 'browsers.launcher' });
    this.clock = deps.clock;
    this.host = deps.host;
    this.mode = deps.stealthDriver;
    this.resolver = deps.driverResolver ?? new DriverResolver({ logger: deps.logger });
    this.chromiumDeps = { env: deps.host.env, ...deps.chromium };
  }

  stealthDriverName(): 'patchright' | 'playwright' {
    return this.resolver.stealthDriverName(this.mode);
  }

  launch(spec: LaunchSpec, signal?: AbortSignal): Promise<SessionHandle> {
    const resolved = spec.stealth
      ? this.resolver.resolveStealth(spec.stealthDriver)
      : { browserType: this.resolver.stock(), driver: 'playwright' as const };
    return withSpan(
      SPAN.BROWSER_LAUNCH,
      {
        [ATTR.SESSION_ID]: spec.sessionId,
        [ATTR.CHANNEL]: spec.channel,
        [ATTR.STEALTH]: spec.stealth,
        [ATTR.PERSISTENCE_MODE]: spec.persistenceMode,
        [ATTR.HEADLESS]: spec.headless,
        [ATTR.DRIVER]: resolved.driver,
      },
      () => this.launchWith(resolved.browserType, resolved.driver, spec, signal),
    );
  }

  private async launchWith(
    browserType: BrowserType,
    driver: 'patchright' | 'playwright',
    spec: LaunchSpec,
    signal: AbortSignal | undefined,
  ): Promise<SessionHandle> {
    const log = this.logger.child({ sessionId: spec.sessionId });
    const warnings: LaunchWarning[] = [];
    const kwargs = launchKwargsForChannel(spec.channel, {
      incognito: spec.incognito,
      headless: spec.headless,
    });
    const launch = buildLaunchOptions({
      kwargs,
      stealth: spec.stealth,
      launchOptions: spec.launchOptions,
      proxy: spec.proxy,
      downloadsDir: spec.downloadsDir,
    });
    const executablePath = spec.launchOptions?.executablePath;
    if (executablePath !== undefined) {
      warnings.push(executablePathWarning(executablePath, spec.channel));
    } else {
      assertChromiumInstalled(browserType, spec.channel, this.chromiumDeps);
    }

    // Identity-derived context options are spread BEFORE the caller's, so an explicit
    // `context_options.viewport` / `locale` / `timezoneId` still wins — the same precedence the
    // launch-options merge uses. A caller who states their own truth is the best source there is.
    const identityContext: BrowserContextOptions =
      spec.identity !== undefined
        ? contextOptionsFor(
            spec.identity.fingerprint,
            spec.identity.geo,
            spec.identity.assertDisplay,
          )
        : {};
    // A saved storage-state *name* (string `storageState`) was resolved to `storageStatePath` by the
    // pipeline; the caller's string must not override the resolved managed file.
    const { storageState: callerStorageState, ...callerContext } = spec.contextOptions ?? {};
    const storageState =
      spec.persistenceMode !== 'persistent' && spec.storageStatePath !== undefined
        ? spec.storageStatePath
        : callerStorageState;
    const contextOptions: BrowserContextOptions = {
      ...identityContext,
      ...callerContext,
      ...(storageState !== undefined && { storageState }),
    };
    // One init script for every stealth session (spec 11 §2.4: one masking helper, one toString
    // proxy): the display half only when asserted, the deviceMemory fallback always.
    const scriptPayload = spec.stealth
      ? mergeNativeGetterPayloads(
          spec.identity?.assertDisplay ? scriptPayloadFor(spec.identity.fingerprint) : undefined,
          deviceMemoryPayload(),
        )
      : null;

    let browser: Browser | null = null;
    let context: BrowserContext;
    let page: Page;
    try {
      if (spec.persistenceMode === 'persistent') {
        if (spec.userDataDir === undefined) {
          throw new AppError(
            'INTERNAL_ERROR',
            { ref: 'persistent-user-data-dir' },
            { message: 'persistent mode requires a resolved userDataDir (internal invariant)' },
          );
        }
        // `launchPersistentContext` takes launch AND context options in one bag and returns the
        // context directly (its browser is torn down when the context closes). The managed
        // `userDataDir` is resolved upstream; a user-supplied one is rejected there.
        context = await browserType.launchPersistentContext(spec.userDataDir, {
          ...launch.options,
          ...contextOptions,
        });
        // Chromium has already opened `pages()[0]` here, but it sits at `about:blank` — no navigation
        // has happened, so a context-level init script still lands before any page script runs.
        if (scriptPayload !== null)
          await context.addInitScript(installNativeGetters, scriptPayload);
        page = context.pages()[0] ?? (await context.newPage());
        browser = context.browser();
      } else {
        // `memory` and `storage-state` share the same mechanics: launch a browser, then open a
        // context. For `storage-state`, the snapshot rides through `storageState`.
        browser = await browserType.launch(launch.options);
        context = await browser.newContext(contextOptions);
        // Before `newPage()`, so the first tab is covered like every later one.
        if (scriptPayload !== null)
          await context.addInitScript(installNativeGetters, scriptPayload);
        page = await context.newPage();
      }
    } catch (err) {
      if (isAppError(err)) throw err;
      const notInstalled = browserNotInstalledFromLaunchError(err, spec.channel, this.chromiumDeps);
      if (notInstalled !== null) throw notInstalled;
      throw new AppError(
        'INTERNAL_ERROR',
        { ref: 'browser-launch' },
        { message: `browser launch failed: ${serializeError(err).message}`, cause: err },
      );
    }

    const closeQuietly = async (): Promise<void> => {
      try {
        await context.close();
      } catch {
        // Already gone.
      }
      try {
        await browser?.close();
      } catch {
        // Already gone.
      }
    };
    if (signal?.aborted) {
      await closeQuietly();
      throw new AppError(
        'INTERNAL_ERROR',
        { ref: 'launch-aborted' },
        { message: 'launch aborted by caller', cause: signal.reason },
      );
    }

    // Start per-session tracing before the agent can drive the page, so the whole session is
    // captured. Best-effort — a tracing failure must not fail the launch.
    let tracing: PlaywrightTracingHandle | null = null;
    if (spec.tracing?.enabled === true) {
      const handle = new PlaywrightTracingHandle({
        tracing: context.tracing,
        partsDir: spec.tracing.partsDir,
        screenshots: spec.tracing.screenshots,
        snapshots: spec.tracing.snapshots,
        logger: log,
      });
      try {
        await handle.start();
        tracing = handle;
      } catch (err) {
        warnings.push(traceStartWarning(err));
      }
    }

    // Apply the stealth identity override before the agent can drive the page (no navigation has
    // happened yet). Best-effort — a failure downgrades to the honest baseline, never fails launch.
    let identity: AppliedIdentity | null = null;
    let applier: IdentityApplier | null = null;
    if (spec.stealth) {
      const candidate = new IdentityApplier(context, { host: this.host, logger: log });
      try {
        identity = await candidate.apply(page, {
          geo: spec.identity?.geo ?? null,
          display: displayFor(spec),
        });
        applier = candidate;
      } catch (err) {
        warnings.push({
          code: 'STEALTH_INIT_FAILED',
          message: 'failed to apply the stealth identity override; continuing without it',
          details: { error: serializeError(err) },
        });
        await candidate.dispose();
      }
    }

    log.info('browser launched', {
      driver,
      channel: spec.channel,
      headless: spec.headless,
      stealth: spec.stealth,
      persistence_mode: spec.persistenceMode,
      warnings: warnings.map((w) => w.code),
      launched_at: this.clock.now(),
    });

    return new PlaywrightSessionHandle({
      sessionId: spec.sessionId,
      browser,
      context,
      page,
      capabilities: capabilitiesFor(driver, spec),
      driver,
      identity,
      warnings,
      tracing,
      applier,
      logger: this.logger,
    });
  }
}

/** Only record the display half when it was actually asserted, so metadata never claims a geometry the page was not given. */
function displayFor(spec: LaunchSpec): AppliedDisplay | null {
  const identity = spec.identity;
  if (identity === undefined || !identity.assertDisplay) return null;
  const fp = identity.fingerprint;
  return {
    screen: { width: fp.screen.width, height: fp.screen.height },
    viewport: { ...fp.viewport },
    deviceScaleFactor: fp.deviceScaleFactor,
  };
}

/** Engine capabilities of a Chromium session (spec 11 §2.1). */
export function capabilitiesFor(
  driver: 'patchright' | 'playwright',
  spec: Pick<LaunchSpec, 'headless'>,
): EngineCapabilities {
  return {
    cdpScreencast: true,
    // Chromium can only print to PDF in headless mode.
    pdf: spec.headless,
    trace: true,
    closedShadowRoot: driver === 'patchright',
    perContextProxy: true,
    // Patchright's isolated-world `evaluate` needs the `isolatedContext: false` argument.
    isolatedEvaluate: driver === 'patchright',
  };
}

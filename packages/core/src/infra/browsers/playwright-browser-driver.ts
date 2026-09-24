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
import { channelExecutable, playwrightChannelExecutable } from './browser-detection.ts';
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
import { isSandboxFailure, sandboxFailureReason } from './sandbox.ts';
import { sandboxUnavailable } from './sandbox-error.ts';
import { SandboxPolicy } from './sandbox-policy.ts';
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
  /** The `sandbox` setting; defaults to `off` (today's launches, byte for byte). */
  readonly sandbox?: SandboxPolicy;
  /** Test seam: the executable a branded channel launches (Playwright's own lookup by default). */
  readonly locateChannel?: (playwrightChannel: 'chrome' | 'msedge') => string | null;
}

/** What an agent is told when nothing better is known about this host. */
export const ASK_OPERATOR_GUIDANCE: readonly string[] = [
  "Ask the operator to run 'browserhive doctor' for the options on this host.",
  'Or launch without launch_options.chromiumSandbox.',
];

/** The `off` policy used when none is configured: required sandboxes still fail typed. */
function defaultSandboxPolicy(deps: PlaywrightBrowserDriverDeps): SandboxPolicy {
  return new SandboxPolicy({
    mode: 'off',
    root: false,
    logger: deps.logger,
    clock: deps.clock,
    unavailable: ({ target, reason, requiredBy, err }) =>
      sandboxUnavailable({
        channel: target.channel,
        reason,
        requiredBy,
        alternatives: [],
        guidance: [...ASK_OPERATOR_GUIDANCE],
        ...(err !== undefined && { err }),
      }),
  });
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
  private readonly sandbox: SandboxPolicy;
  private readonly locateChannel: (playwrightChannel: 'chrome' | 'msedge') => string | null;

  constructor(deps: PlaywrightBrowserDriverDeps) {
    this.logger = deps.logger.child({ module: 'browsers.launcher' });
    this.clock = deps.clock;
    this.host = deps.host;
    this.mode = deps.stealthDriver;
    this.resolver = deps.driverResolver ?? new DriverResolver({ logger: deps.logger });
    this.chromiumDeps = { env: deps.host.env, ...deps.chromium };
    this.sandbox = deps.sandbox ?? defaultSandboxPolicy(deps);
    this.locateChannel = deps.locateChannel ?? playwrightChannelExecutable;
  }

  /** The executable a channel launches, the sandbox policy's cache key (null when unknown). */
  private executableFor(browserType: BrowserType, channel: LaunchSpec['channel']): string | null {
    return channelExecutable(
      channel,
      () => {
        try {
          const path = browserType.executablePath();
          return path === '' ? null : path;
        } catch {
          return null;
        }
      },
      this.locateChannel,
    );
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

    if (spec.persistenceMode === 'persistent' && spec.userDataDir === undefined) {
      throw new AppError(
        'INTERNAL_ERROR',
        { ref: 'persistent-user-data-dir' },
        { message: 'persistent mode requires a resolved userDataDir (internal invariant)' },
      );
    }
    const userDataDir = spec.userDataDir;
    // One launch of this session's browser with or without Chromium's sandbox; the policy decides
    // which (spec 11 §4.1): `off` never, `on` always, `auto` where this executable can.
    const open = async (
      sandboxed: boolean,
    ): Promise<{ browser: Browser | null; context: BrowserContext; page: Page }> => {
      const { chromiumSandbox: _requested, ...rest } = launch.options;
      const options = sandboxed ? { ...rest, chromiumSandbox: true } : rest;
      if (spec.persistenceMode === 'persistent' && userDataDir !== undefined) {
        // `launchPersistentContext` takes launch AND context options in one bag and returns the
        // context directly (its browser is torn down when the context closes). The managed
        // `userDataDir` is resolved upstream; a user-supplied one is rejected there.
        const context = await browserType.launchPersistentContext(userDataDir, {
          ...options,
          ...contextOptions,
        });
        // Chromium has already opened `pages()[0]` here, but it sits at `about:blank` — no navigation
        // has happened, so a context-level init script still lands before any page script runs.
        if (scriptPayload !== null)
          await context.addInitScript(installNativeGetters, scriptPayload);
        const page = context.pages()[0] ?? (await context.newPage());
        return { browser: context.browser(), context, page };
      }
      // `memory` and `storage-state` share the same mechanics: launch a browser, then open a
      // context. For `storage-state`, the snapshot rides through `storageState`.
      const browser = await browserType.launch(options);
      const context = await browser.newContext(contextOptions);
      // Before `newPage()`, so the first tab is covered like every later one.
      if (scriptPayload !== null) await context.addInitScript(installNativeGetters, scriptPayload);
      const page = await context.newPage();
      return { browser, context, page };
    };

    let browser: Browser | null = null;
    let context: BrowserContext;
    let page: Page;
    let sandboxed = false;
    try {
      const target = {
        channel: spec.channel,
        executablePath: executablePath ?? this.executableFor(browserType, spec.channel),
      };
      const opened = await this.sandbox.launch(
        target,
        spec.launchOptions?.chromiumSandbox === true,
        open,
        // A launch made only to prove the sandbox was the cause is closed again at once.
        async (proof) => {
          await proof.context.close().catch(() => undefined);
          await proof.browser?.close().catch(() => undefined);
        },
      );
      ({ browser, context, page } = opened.value);
      sandboxed = opened.sandboxed;
    } catch (err) {
      if (isAppError(err)) throw err;
      const notInstalled = browserNotInstalledFromLaunchError(err, spec.channel, this.chromiumDeps);
      if (notInstalled !== null) throw notInstalled;
      // A sandbox that cannot start is a property of this host, not an internal fault: retrying
      // never helps, so it must not read as INTERNAL_ERROR with `backoff`.
      if (isSandboxFailure(err)) {
        throw sandboxUnavailable({
          channel: spec.channel,
          reason: sandboxFailureReason(err),
          requiredBy: 'launch_options',
          alternatives: [],
          guidance: [...ASK_OPERATOR_GUIDANCE],
          err,
        });
      }
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
      sandboxed,
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
      browserInfo: { version: browser?.version() ?? null, sandboxed },
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

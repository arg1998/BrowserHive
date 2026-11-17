/** @module infra/browsers/playwright-browser-driver — the BrowserDriver adapter over the Playwright API, driven by Patchright (D-65): launch pipeline for memory/storage-state/persistent, identity, tracing, capabilities (spec 11 §2). */

import type { HeadedWindows } from '@browserhive/contracts/enums';
import type { Browser, BrowserContext, BrowserContextOptions, BrowserType, Page } from 'patchright';
import { AppError, isAppError } from '../../kernel/errors/app-error.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type {
  AppliedIdentity,
  BrowserDriver,
  LaunchedSession,
  LaunchSpec,
  LaunchWarning,
} from '../../ports/browser-driver.ts';
import type { Clock } from '../../ports/clock.ts';
import type { Logger } from '../../ports/logger.ts';
import type {
  TemplateHost,
  TemplateHostLauncher,
  TemplateHostSpec,
  TemplatePageWatcher,
} from '../../ports/template-host.ts';
import { clearProfileSecrets } from '../persistence/profile-secrets.ts';
import { ATTR, SPAN, withSpan } from '../telemetry/spans.ts';
import { playwrightChannelExecutable } from './browser-detection.ts';
import { PlaywrightBrowserHost } from './browser-host.ts';
import { launchKwargsForChannel, withExtraArgs } from './channel.ts';
import {
  assertChromiumInstalled,
  browserNotInstalledFromLaunchError,
  type ChromiumResolverDeps,
} from './chromium-resolver.ts';
import { DRIVER_NAME, driverChromium, suppressInjectRoute } from './driver.ts';
import {
  capabilitiesFor,
  defaultSandboxPolicy,
  displayFor,
  executableOf,
} from './driver-support.ts';
import { contextOptionsFor, scriptPayloadFor } from './fingerprint.ts';
import { ExclusiveWindows } from './headed-windows.ts';
import type { HostFacts } from './host-facts.ts';
import { IdentityApplier } from './identity-applier.ts';
import { buildLaunchOptions, executablePathWarning } from './launch-args.ts';
import { installNativeGetters, mergeNativeGetterPayloads } from './native-getter.ts';
import type { SandboxPolicy } from './sandbox-policy.ts';
import { ExclusiveSessionView } from './session-view.ts';
import { deviceMemoryPayload } from './stealth-identity.ts';
import {
  launchTemplateHostWith,
  type TemplateLaunchContext,
  type TemplateRequestGuard,
} from './template-launch.ts';
import { PlaywrightTracingHandle, traceStartWarning } from './tracing.ts';

/** Constructor dependencies of {@link PlaywrightBrowserDriver}. */
export interface PlaywrightBrowserDriverDeps {
  readonly logger: Logger;
  readonly clock: Clock;
  readonly host: HostFacts;
  /** Test seam; defaults to Patchright's Chromium (the only driver, D-65). */
  readonly browserType?: BrowserType;
  /** Test seam for the binary pre-check. */
  readonly chromium?: Omit<ChromiumResolverDeps, 'env'>;
  /** The `sandbox` setting; defaults to `off` (today's launches, byte for byte). */
  readonly sandbox?: SandboxPolicy;
  /** Test seam: the executable a branded channel launches (Playwright's own lookup by default). */
  readonly locateChannel?: (playwrightChannel: 'chrome' | 'msedge') => string | null;
  /** The configured blocklist, which every template host's chain carries (spec 13 §3.8). */
  readonly templateBlocklist?: TemplateLaunchContext['blocklist'];
  /** Switches of the internal testing seam for exclusive sessions (spec 13 §14); never agent input. */
  readonly testingArgs?: readonly string[];
  /**
   * The `headedWindows` setting (D-77): `minimized` keeps every window of a headed exclusive session
   * minimized from its first one on. Defaults to `normal` (tests); the composition passes the
   * setting, whose own default is `minimized`.
   */
  readonly headedWindows?: HeadedWindows;
}

/**
 * Production driver: a real Patchright Chromium per session (`browserType.launch`, every stealth
 * level, D-65); one browser subprocess and one context per session, nothing shared between them.
 */
export class PlaywrightBrowserDriver implements BrowserDriver, TemplateHostLauncher {
  private readonly logger: Logger;
  private readonly clock: Clock;
  private readonly testingArgs: readonly string[];
  private readonly headedWindows: HeadedWindows;
  private readonly host: HostFacts;
  private readonly browserType: BrowserType;
  private readonly chromiumDeps: ChromiumResolverDeps;
  private readonly sandbox: SandboxPolicy;
  private readonly locateChannel: (playwrightChannel: 'chrome' | 'msedge') => string | null;
  private readonly templateBlocklist: TemplateLaunchContext['blocklist'];
  private templatePages: TemplatePageWatcher | null = null;
  private templateRequestGuard: TemplateRequestGuard | null = null;

  constructor(deps: PlaywrightBrowserDriverDeps) {
    this.logger = deps.logger.child({ module: 'browsers.launcher' });
    this.clock = deps.clock;
    this.host = deps.host;
    this.browserType = deps.browserType ?? driverChromium();
    this.chromiumDeps = { env: deps.host.env, ...deps.chromium };
    this.sandbox = deps.sandbox ?? defaultSandboxPolicy(deps);
    this.locateChannel = deps.locateChannel ?? playwrightChannelExecutable;
    this.templateBlocklist = deps.templateBlocklist ?? null;
    this.testingArgs = deps.testingArgs ?? [];
    this.headedWindows = deps.headedWindows ?? 'normal';
  }

  /** Attaches the watcher of template hosts' pages (site pack challenges, spec 13 §9.5). */
  attachTemplatePageWatcher(watcher: TemplatePageWatcher | null): void {
    this.templatePages = watcher;
  }

  /** The site-pack request guard of every template host started from now on (spec 13 §9.3). */
  setTemplateRequestGuard(guard: TemplateRequestGuard | null): void {
    this.templateRequestGuard = guard;
  }

  /** Starts a template host (spec 13 §3.1); the start is not abortable once Chromium is spawning. */
  launchTemplateHost(spec: TemplateHostSpec): Promise<TemplateHost> {
    assertChromiumInstalled(this.browserType, spec.channel, this.chromiumDeps);
    return launchTemplateHostWith(
      {
        browserType: this.browserType,
        driver: DRIVER_NAME,
        sandbox: this.sandbox,
        sandboxTarget: {
          channel: spec.channel,
          executablePath: executableOf(this.browserType, spec.channel, this.locateChannel),
        },
        chromium: this.chromiumDeps,
        host: this.host,
        clock: this.clock,
        logger: this.logger,
        blocklist: this.templateBlocklist,
        pageWatcher: () => this.templatePages,
        requestGuard: this.templateRequestGuard,
      },
      spec,
    );
  }

  /** Empties saved passwords and autofill of a stopped template profile (spec 13 §3.1). */
  readonly clearProfileSecrets = async (dir: string): Promise<void> => clearProfileSecrets(dir);

  stealthDriverName(): 'patchright' {
    return DRIVER_NAME;
  }

  launch(spec: LaunchSpec, signal?: AbortSignal): Promise<LaunchedSession> {
    return withSpan(
      SPAN.BROWSER_LAUNCH,
      {
        [ATTR.SESSION_ID]: spec.sessionId,
        [ATTR.CHANNEL]: spec.channel,
        [ATTR.STEALTH]: spec.stealth,
        [ATTR.PERSISTENCE_MODE]: spec.persistenceMode,
        [ATTR.HEADLESS]: spec.headless,
        [ATTR.DRIVER]: DRIVER_NAME,
      },
      () => this.launchWith(this.browserType, DRIVER_NAME, spec, signal),
    );
  }

  private async launchWith(
    browserType: BrowserType,
    driver: 'patchright',
    spec: LaunchSpec,
    signal: AbortSignal | undefined,
  ): Promise<LaunchedSession> {
    const log = this.logger.child({ sessionId: spec.sessionId });
    const warnings: LaunchWarning[] = [];
    const kwargs = launchKwargsForChannel(spec.channel, {
      incognito: spec.incognito,
      headless: spec.headless,
    });
    const launch = buildLaunchOptions({
      kwargs: withExtraArgs(kwargs, this.testingArgs),
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
    // Headed windows kept minimized (D-77): the first window is created minimized where Chromium
    // allows it (a fresh browser), else minimized right after the launch (a persistent profile's
    // first window, which Chromium shows before BrowserHive can act).
    const minimized = !spec.headless && this.headedWindows === 'minimized';
    // Playwright sizes each window to an emulated viewport (any `viewport` but `null`).
    const emulatedViewport = contextOptions.viewport !== null;
    // One launch of this session's browser with or without Chromium's sandbox; the policy decides
    // which (spec 11 §4.1): `off` never, `on` always, `auto` where this executable can.
    const open = async (
      sandboxed: boolean,
    ): Promise<{
      browser: Browser | null;
      context: BrowserContext;
      page: Page;
      windows: ExclusiveWindows | null;
    }> => {
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
        try {
          // Before the init script and tracing: no Patchright document route (D40).
          suppressInjectRoute(context);
          // Chromium has already opened `pages()[0]` here, but it sits at `about:blank` — no
          // navigation has happened, so a context-level init script still lands before any page
          // script runs.
          if (scriptPayload !== null)
            await context.addInitScript(installNativeGetters, scriptPayload);
          const page = context.pages()[0] ?? (await context.newPage());
          const browser = context.browser();
          const windows =
            minimized && browser !== null
              ? await ExclusiveWindows.open(browser, log, emulatedViewport)
              : null;
          windows?.watch(context);
          await windows?.minimizePage(context, page);
          return { browser, context, page, windows };
        } catch (err) {
          // Never leave a half-opened browser behind (it would also hold the profile lock).
          await context.close().catch(() => undefined);
          throw err;
        }
      }
      // `memory` and `storage-state` share the same mechanics: launch a browser, then open a
      // context. For `storage-state`, the snapshot rides through `storageState`.
      const browser = await browserType.launch(options);
      try {
        const context = await browser.newContext(contextOptions);
        // Before the init script and tracing: no Patchright document route (D40).
        suppressInjectRoute(context);
        // Before `newPage()`, so the first tab is covered like every later one.
        if (scriptPayload !== null)
          await context.addInitScript(installNativeGetters, scriptPayload);
        const windows = minimized
          ? await ExclusiveWindows.open(browser, log, emulatedViewport)
          : null;
        windows?.watch(context);
        const page = windows !== null ? await windows.firstPage(context) : await context.newPage();
        return { browser, context, page, windows };
      } catch (err) {
        await browser.close().catch(() => undefined);
        throw err;
      }
    };

    let browser: Browser | null = null;
    let context: BrowserContext;
    let page: Page;
    let windows: ExclusiveWindows | null;
    let sandboxed = false;
    try {
      const target = {
        channel: spec.channel,
        executablePath:
          executablePath ?? executableOf(browserType, spec.channel, this.locateChannel),
      };
      const opened = await this.sandbox.launch(
        target,
        spec.launchOptions?.chromiumSandbox === true,
        open,
        // A launch made only to prove the sandbox was the cause is closed again at once.
        async (proof) => {
          await proof.windows?.dispose();
          await proof.context.close().catch(() => undefined);
          await proof.browser?.close().catch(() => undefined);
        },
      );
      ({ browser, context, page, windows } = opened.value);
      sandboxed = opened.sandboxed;
    } catch (err) {
      if (isAppError(err)) throw err;
      const notInstalled = browserNotInstalledFromLaunchError(err, spec.channel, this.chromiumDeps);
      if (notInstalled !== null) throw notInstalled;
      // Sandbox failures of a sandboxed attempt were already typed by the policy
      // (SANDBOX_UNAVAILABLE, never INTERNAL_ERROR); what reaches here is an unsandboxed launch.
      throw new AppError(
        'INTERNAL_ERROR',
        { ref: 'browser-launch' },
        { message: `browser launch failed: ${serializeError(err).message}`, cause: err },
      );
    }

    const closeQuietly = async (): Promise<void> => {
      await windows?.dispose();
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

    const host = new PlaywrightBrowserHost({
      sessionId: spec.sessionId,
      browser,
      context,
      capabilities: capabilitiesFor(spec),
      driver,
      identity,
      warnings,
      tracing,
      applier,
      windows,
      clock: this.clock,
      logger: this.logger,
      browserInfo: { version: browser?.version() ?? null, sandboxed },
    });
    // An exclusive host has exactly one view (spec 13 §3.13).
    const userData = spec.persistenceMode === 'persistent' ? (userDataDir ?? null) : null;
    return { view: new ExclusiveSessionView(host, page, userData), host };
  }
}

export { ASK_OPERATOR_GUIDANCE, capabilitiesFor } from './driver-support.ts';

/** @module infra/browsers/template-launch — starts a template host (spec 13 §3.1): proxy reachability, profile preferences, the persistent context with the template's identity and sandbox policy, the host's interception chain, the parked sentinel and the identity applier. */

import { mkdir } from 'node:fs/promises';
import { connect } from 'node:net';
import type { BrowserContext, BrowserContextOptions, BrowserType, Page } from 'playwright';
import { AppError, isAppError } from '../../kernel/errors/app-error.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { LaunchWarning } from '../../ports/browser-driver.ts';
import type { Clock } from '../../ports/clock.ts';
import type { Logger } from '../../ports/logger.ts';
import type { TemplateHost, TemplateHostSpec } from '../../ports/template-host.ts';
import { type BlocklistRouteDeps, blocklistHandler } from './blocklist-route.ts';
import { launchKwargsForChannel } from './channel.ts';
import {
  browserNotInstalledFromLaunchError,
  type ChromiumResolverDeps,
} from './chromium-resolver.ts';
import { contextOptionsFor, deriveFingerprint, scriptPayloadFor } from './fingerprint.ts';
import type { HostFacts } from './host-facts.ts';
import { hostOwnerResolver, selfOriginHandler, templateHostCookies } from './host-interception.ts';
import { IdentityApplier } from './identity-applier.ts';
import { InterceptionChain, type InterceptionHandler } from './interception-chain.ts';
import { buildLaunchOptions } from './launch-args.ts';
import { installNativeGetters, mergeNativeGetterPayloads } from './native-getter.ts';
import { applyTemplatePreferences } from './profile-preferences.ts';
import type { SandboxPolicy, SandboxTarget } from './sandbox-policy.ts';
import { deviceMemoryPayload } from './stealth-identity.ts';
import { PlaywrightTemplateHost } from './template-host.ts';
import { HostTargets } from './template-targets.ts';

/** TCP reachability deadline of a template's proxy (spec 13 §2.2). */
export const PROXY_PROBE_MS = 3_000;

/** Chromium's "no display" failures (spec 13 §3.11), matched on the launch error text. */
const NO_DISPLAY = [
  /missing x server/i,
  /\$DISPLAY/,
  /ozone platform/i,
  /platform failed to initiali[sz]e/i,
  /cannot open display/i,
  /window ?server/i,
];

/** The driver-side facts a host launch needs. */
export interface TemplateLaunchContext {
  readonly browserType: BrowserType;
  readonly driver: 'patchright' | 'playwright';
  readonly sandbox: SandboxPolicy;
  readonly sandboxTarget: SandboxTarget;
  readonly chromium: ChromiumResolverDeps;
  readonly host: HostFacts;
  readonly clock: Clock;
  readonly logger: Logger;
  /** The configured blocklist; joins the host's chain as handler 2 (spec 13 §3.8). */
  readonly blocklist: Omit<BlocklistRouteDeps, 'sessionId' | 'clock' | 'logger'> | null;
}

/** `true` when `err` is one of Chromium's display failures. */
export function isNoDisplayError(err: unknown): boolean {
  const text = serializeError(err).message;
  return NO_DISPLAY.some((pattern) => pattern.test(text));
}

/**
 * Launches the template's persistent context and wraps it in a {@link PlaywrightTemplateHost}.
 * Nothing is admitted before it resolves: the chain is installed (fail-closed: without it the
 * self-origin guard would be missing, so the start fails), restored pages are closed, the sentinel
 * is parked and the identity is applied.
 */
export async function launchTemplateHostWith(
  ctx: TemplateLaunchContext,
  spec: TemplateHostSpec,
): Promise<TemplateHost> {
  const log = ctx.logger.child({ templateId: spec.templateId });
  if (spec.proxy !== null) await assertProxyReachable(spec.proxy.server);
  await mkdir(spec.userDataDir, { recursive: true, mode: 0o700 });
  await mkdir(spec.downloadsDir, { recursive: true, mode: 0o700 });
  await applyTemplatePreferences(spec.userDataDir);

  const kwargs = launchKwargsForChannel(spec.channel, {
    incognito: false,
    headless: spec.headless,
  });
  const launch = buildLaunchOptions({
    kwargs,
    stealth: spec.stealth,
    launchOptions: { args: ['--disable-sync', ...spec.testingArgs] },
    proxy: spec.proxy,
    downloadsDir: spec.downloadsDir,
  });
  const fingerprint = deriveFingerprint({
    seed: spec.identity.seed,
    hostPlatform: ctx.host.platform,
  });
  const assertDisplay = spec.headless && spec.fingerprint;
  const contextOptions: BrowserContextOptions = contextOptionsFor(
    fingerprint,
    spec.identity.geo,
    assertDisplay,
  );
  const open = async (sandboxed: boolean): Promise<BrowserContext> => {
    const { chromiumSandbox: _ignored, ...rest } = launch.options;
    return ctx.browserType.launchPersistentContext(spec.userDataDir, {
      ...rest,
      // The daemon's own shutdown drains and closes hosts (spec 13 §3.2); Playwright's signal
      // handlers would quit the browser first, which a host reads as the operator quitting it.
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      ...(sandboxed && { chromiumSandbox: true }),
      ...contextOptions,
    });
  };
  let context: BrowserContext;
  let sandboxed: boolean;
  try {
    const opened = await ctx.sandbox.launch(ctx.sandboxTarget, false, open, (proof) =>
      proof.close().catch(() => undefined),
    );
    context = opened.value;
    sandboxed = opened.sandboxed;
  } catch (err) {
    throw launchError(err, spec, ctx);
  }

  try {
    if (spec.stealth) {
      const payload = mergeNativeGetterPayloads(
        assertDisplay ? scriptPayloadFor(fingerprint) : undefined,
        deviceMemoryPayload(),
      );
      await context.addInitScript(installNativeGetters, payload);
    }
    // Before anything navigates: every request to BrowserHive carries the marker the daemon
    // refuses, redirect hops included (spec 13 §3.8).
    await context.addCookies(templateHostCookies(spec.selfOrigins));
    const anchor = context.pages()[0] ?? (await context.newPage());
    const targets = await HostTargets.open(context, anchor, log);
    const host = buildHost(ctx, spec, context, targets, sandboxed);
    await installHostChain(host);
    await host.adoptStartPages();
    if (spec.stealth) await applyIdentity(ctx, spec, host, anchor, log);
    log.info('template host started', {
      driver: ctx.driver,
      channel: spec.channel,
      headless: spec.headless,
      sandboxed,
    });
    return host;
  } catch (err) {
    // Never leave a half-started browser behind: it would hold the profile's SingletonLock.
    await context.close().catch(() => undefined);
    throw isAppError(err)
      ? err
      : new AppError(
          'INTERNAL_ERROR',
          { ref: 'template-host-start' },
          { message: `template host start failed: ${serializeError(err).message}`, cause: err },
        );
  }
}

function buildHost(
  ctx: TemplateLaunchContext,
  spec: TemplateHostSpec,
  context: BrowserContext,
  targets: HostTargets,
  sandboxed: boolean,
): PlaywrightTemplateHost {
  let attribution: PlaywrightTemplateHost | null = null;
  const handlers: InterceptionHandler[] = [
    selfOriginHandler({ origins: spec.selfOrigins, logger: ctx.logger }),
  ];
  if (ctx.blocklist !== null) {
    handlers.push(
      blocklistHandler({
        ...ctx.blocklist,
        sessionId: spec.templateId,
        clock: ctx.clock,
        logger: ctx.logger,
      }),
    );
  }
  const chain = new InterceptionChain({
    handlers,
    resolveOwner: hostOwnerResolver({
      attribution: { attributionOf: (page) => attribution?.dispatcher.attributionOf(page) },
      clock: ctx.clock,
    }),
    logger: ctx.logger,
  });
  const host = new PlaywrightTemplateHost({
    templateId: spec.templateId,
    context,
    targets,
    chain,
    capabilities: {
      cdpScreencast: true,
      pdf: spec.headless,
      // Tracing is off for template hosts in v1 (spec 13 §5.4).
      trace: false,
      closedShadowRoot: ctx.driver === 'patchright',
      perContextProxy: true,
      isolatedEvaluate: ctx.driver === 'patchright',
    },
    driver: ctx.driver,
    browserInfo: { version: context.browser()?.version() ?? null, sandboxed },
    warnings: [],
    headless: spec.headless,
    window: spec.window,
    clock: ctx.clock,
    logger: ctx.logger,
  });
  attribution = host;
  return host;
}

/** Installs the chain; a host without it would lack the self-origin guard, so this throws. */
async function installHostChain(host: PlaywrightTemplateHost): Promise<void> {
  const installed = await host.chain.install(host.context);
  if (!installed.ok) {
    throw new AppError(
      'INTERNAL_ERROR',
      { ref: 'template-host-route' },
      { message: 'the template host route could not be installed', cause: installed.error },
    );
  }
}

async function applyIdentity(
  ctx: TemplateLaunchContext,
  spec: TemplateHostSpec,
  host: PlaywrightTemplateHost,
  anchor: Page,
  log: Logger,
): Promise<void> {
  const applier = new IdentityApplier(host.context, {
    host: ctx.host,
    logger: log,
    openProbePage: () => host.openProbePage(),
  });
  try {
    const identity = await applier.apply(anchor, { geo: spec.identity.geo, display: null });
    host.attachIdentity(identity, applier);
  } catch (err) {
    const warning: LaunchWarning = {
      code: 'STEALTH_INIT_FAILED',
      message: 'failed to apply the stealth identity override; continuing without it',
      details: { error: serializeError(err) },
    };
    host.warnings.push(warning);
    await applier.dispose();
  }
}

function launchError(err: unknown, spec: TemplateHostSpec, ctx: TemplateLaunchContext): AppError {
  if (isAppError(err)) return err;
  const notInstalled = browserNotInstalledFromLaunchError(err, spec.channel, ctx.chromium);
  if (notInstalled !== null) return notInstalled;
  const ref = isNoDisplayError(err) ? 'no_display' : 'browser-launch';
  return new AppError(
    'INTERNAL_ERROR',
    { ref },
    { message: `template host launch failed: ${serializeError(err).message}`, cause: err },
  );
}

/** Opens a TCP connection to the proxy (spec 13 §2.2); BrowserHive never falls back to the host's IP. */
async function assertProxyReachable(server: string): Promise<void> {
  const url = new URL(server);
  const port = Number(
    url.port || (url.protocol === 'https:' ? 443 : url.protocol.startsWith('socks') ? 1080 : 80),
  );
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const reachable = await new Promise<boolean>((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(PROXY_PROBE_MS, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
  if (!reachable) {
    throw new AppError(
      'INTERNAL_ERROR',
      { ref: 'proxy_unreachable' },
      { message: `template proxy ${url.host} is not reachable` },
    );
  }
}

/** @module infra/browsers/template-host — the shared browser of a template (spec 13 §3.1–§3.6): every page attributed before any session sees it, background windows claimed by target id, the parked sentinel (recreated when closed by hand), the parked-page bound, crash and operator-stop detection, and a close only the supervisor calls. */

import type { Browser, BrowserContext, Page } from 'playwright';
import { AppError } from '../../kernel/errors/app-error.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type {
  AppliedIdentity,
  Cookie,
  EngineCapabilities,
  LaunchWarning,
  SessionBrowserInfo,
  SessionView,
} from '../../ports/browser-driver.ts';
import type { Clock } from '../../ports/clock.ts';
import type { Logger } from '../../ports/logger.ts';
import type {
  ParkedPageInfo,
  SharedWindowInfo,
  SignInRemoval,
  TemplateHost,
  TemplateHostExit,
  TemplateViewOptions,
} from '../../ports/template-host.ts';
import { closeContextWithin, readBrowserPid } from './host-process.ts';
import { SentinelKeeper } from './host-sentinel.ts';
import type { IdentityApplier } from './identity-applier.ts';
import type { InterceptionChain } from './interception-chain.ts';
import { PARKED, type PageOwner, sessionOwner, type TargetFacts } from './page-attribution.ts';
import { HostPageDispatcher } from './page-dispatcher.ts';
import { PageWaiters } from './page-waiters.ts';
import { ParkedPages } from './parked-pages.ts';
import * as ops from './template-host-ops.ts';
import type { HostTargets } from './template-targets.ts';
import { TemplateSessionView, type TemplateViewHost } from './template-view.ts';

/** How long a created window may take to be adopted and attributed (spec 13 §3.3). */
export const ADOPTION_DEADLINE_MS = 10_000;
export { OPERATOR_STOP_WINDOW_MS, SENTINEL_GRACE_MS } from './host-sentinel.ts';
export { MAX_PARKED_PAGES } from './parked-pages.ts';

/** What the launcher hands the host. */
export interface TemplateHostInput {
  readonly templateId: string;
  readonly context: BrowserContext;
  readonly targets: HostTargets;
  readonly chain: InterceptionChain;
  readonly capabilities: EngineCapabilities;
  readonly driver: 'patchright' | 'playwright';
  readonly browserInfo: SessionBrowserInfo;
  readonly warnings: readonly LaunchWarning[];
  readonly headless: boolean;
  readonly window: { readonly width: number; readonly height: number };
  /** Saved passwords or autofill data were found in the profile before the start (spec 13 §3.1). */
  readonly profileSecrets?: boolean;
  /** The profile directory (a sign-in removal finds origins stored by earlier starts). */
  readonly userDataDir?: string;
  readonly clock: Clock;
  readonly logger: Logger;
}

/** A template host over a persistent context; built by the driver, held only by the supervisor. */
export class PlaywrightTemplateHost implements TemplateHost, TemplateViewHost {
  readonly hostId: string;
  readonly kind = 'template' as const;
  readonly browser: Browser | null;
  readonly context: BrowserContext;
  readonly capabilities: EngineCapabilities;
  readonly driver: 'patchright' | 'playwright';
  readonly browserInfo: SessionBrowserInfo;
  readonly warnings: LaunchWarning[];
  readonly tracing = null;
  readonly headless: boolean;
  readonly dispatcher: HostPageDispatcher;
  /** The host's one interception chain (spec 13 §3.8); it lives as long as the context. */
  readonly chain: InterceptionChain;
  readonly profileSecrets: boolean;
  readonly targets: HostTargets;
  private readonly window: { readonly width: number; readonly height: number };
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly views = new Map<string, TemplateSessionView>();
  private readonly waiters: PageWaiters;
  private readonly parked: ParkedPages;
  private readonly origins = new Set<string>();
  private readonly userDataDir: string | null;
  private readonly exitListeners = new Set<(exit: TemplateHostExit) => void>();
  private applied: { identity: AppliedIdentity; applier: IdentityApplier } | null = null;
  private readonly keeper: SentinelKeeper;
  private closing = false;
  private closed: Promise<readonly LaunchWarning[]> | undefined;
  private pid: Promise<number | null> | undefined;

  constructor(input: TemplateHostInput) {
    this.hostId = input.templateId;
    this.context = input.context;
    this.browser = input.context.browser();
    this.targets = input.targets;
    this.chain = input.chain;
    this.capabilities = input.capabilities;
    this.driver = input.driver;
    this.browserInfo = input.browserInfo;
    this.warnings = [...input.warnings];
    this.headless = input.headless;
    this.window = input.window;
    this.clock = input.clock;
    this.profileSecrets = input.profileSecrets === true;
    this.userDataDir = input.userDataDir ?? null;
    this.waiters = new PageWaiters(input.clock);
    this.log = input.logger.child({
      module: 'browsers.template-host',
      templateId: input.templateId,
    });
    this.parked = new ParkedPages(input.clock, this.log);
    this.dispatcher = new HostPageDispatcher({
      fallback: PARKED,
      factsOf: (page) => this.targets.factsOf(page),
      clock: input.clock,
      logger: this.log,
      onCommitted: (page, owner, facts) => this.committed(page, owner, facts),
      onReleased: (page) => void page.close({ runBeforeUnload: false }).catch(() => undefined),
    });
    this.keeper = new SentinelKeeper({
      context: this.context,
      dispatcher: this.dispatcher,
      targets: this.targets,
      headless: this.headless,
      clock: input.clock,
      log: this.log,
      closing: () => this.closing,
      openParkedWindow: () => this.openWindow(null, !this.headless),
      adopted: (page) => this.parked.delete(page),
    });
    this.targets.onLostTarget((facts) => this.dispatcher.adoptClosedTarget(facts));
    this.targets.onDestroyed((targetId) => this.keeper.targetDestroyed(targetId));
    this.browser?.on('disconnected', () => this.exited('browser disconnected'));
    this.context.on('close', () => this.exited('context closed'));
    this.context.on('page', (page) => this.dispatcher.adopt(page));
  }

  get identity(): AppliedIdentity | null {
    return this.applied?.identity ?? null;
  }

  /** The start pages: the sentinel parked (minimized when headed), restored pages closed. */
  adoptStartPages(): Promise<void> {
    return this.keeper.adoptStartPages();
  }

  /** Records the identity the launcher applied (the applier's page subscription stays host-level). */
  attachIdentity(identity: AppliedIdentity, applier: IdentityApplier): void {
    this.applied = { identity, applier };
  }

  /** A parked page created by the host (the Edge UA-CH probe, spec 13 §3.1). */
  openProbePage(): Promise<Page> {
    return this.openWindow(null, !this.headless);
  }

  ensureIdentityForPage(page: Page): Promise<void> {
    return this.applied === null ? Promise.resolve() : this.applied.applier.ensureForPage(page);
  }

  /** A recording or re-login window is open on this host (spec 13 §3.3). */
  get recording(): boolean {
    for (const view of this.views.values()) if (view.recording) return true;
    return false;
  }

  async openView(sessionId: string, options: TemplateViewOptions): Promise<SessionView> {
    if (this.closing) throw unavailable('host closing');
    const agent = options.maintenance !== true;
    const minimized =
      !this.headless && agent && (options.windowState === 'minimized' || this.recording);
    const page = await this.openWindow(sessionId, minimized, options.signal);
    const view = new TemplateSessionView(this, sessionId, page, options, this.log);
    this.views.set(sessionId, view);
    await view.prepareFirstPage();
    // The operator signs in now: agent windows step aside (never raised again by BrowserHive).
    if (view.recording && !this.headless) await ops.minimizeAgentWindows(this, this.views.values());
    return view;
  }

  /**
   * Creates a background window and resolves with its page once attributed to `sessionId`
   * (`null`: parked). Order (spec 13 §3.3): mark the create, `createTarget`, claim, settle.
   */
  async openWindow(
    sessionId: string | null,
    minimized: boolean,
    signal?: AbortSignal,
  ): Promise<Page> {
    const owner: PageOwner = sessionId === null ? PARKED : sessionOwner(sessionId);
    const settle = this.dispatcher.beginCreate();
    let targetId: string;
    try {
      targetId = await this.targets.createWindow({ ...this.window, minimized });
    } catch (err) {
      settle();
      throw unavailable('window not created', err);
    }
    const adopted = this.waiters.wait(
      sessionId,
      (facts) => facts.targetId === targetId,
      ADOPTION_DEADLINE_MS,
      signal,
    );
    const accepted = this.dispatcher.claim(targetId, owner);
    settle();
    if (!accepted) adopted.cancel();
    const page = await adopted.promise;
    if (page === null) {
      await this.targets.closeTarget(targetId);
      throw unavailable(accepted ? 'window not adopted in time' : 'window parked before its claim');
    }
    return page;
  }

  awaitPage(
    sessionId: string,
    match: (facts: TargetFacts) => boolean,
    ms: number,
  ): Promise<Page | null> {
    return this.waiters.wait(sessionId, match, ms).promise;
  }

  async resizeWindow(page: Page, width: number, height: number): Promise<void> {
    const targetId = this.dispatcher.targetIdOf(page);
    if (targetId === undefined) return;
    const clamp = (value: number, max: number) => Math.max(1, Math.min(value, max));
    await this.targets.resize(
      targetId,
      clamp(width, this.window.width),
      clamp(height, this.window.height),
    );
  }

  viewClosed(sessionId: string): void {
    this.views.delete(sessionId);
  }

  viewIds(): readonly string[] {
    return [...this.views.keys()];
  }

  agentPageCount(): number {
    let count = 0;
    for (const [id, view] of this.views) {
      if (!view.maintenance) count += this.dispatcher.pagesOf(id).length;
    }
    return count;
  }

  sessionPageCount(sessionId: string): number {
    return this.dispatcher.pagesOf(sessionId).length;
  }

  parkedPages(): readonly ParkedPageInfo[] {
    return this.parked.list();
  }

  async jar(): Promise<readonly Cookie[]> {
    return await this.context.cookies();
  }

  clearSignIn(domain: string): Promise<SignInRemoval> {
    const page = this.keeper.page ?? this.context.pages()[0];
    return ops.clearSignIn(
      {
        context: this.context,
        dispatcher: this.dispatcher,
        targets: this.targets,
        committedOrigins: this.origins,
        userDataDir: this.userDataDir,
        log: this.log,
        storageSession: () =>
          page === undefined
            ? Promise.reject(new Error('no page'))
            : this.context.newCDPSession(page),
      },
      domain,
    );
  }

  async stepAside(page: Page): Promise<void> {
    if (this.headless) return;
    const sign = [...this.views.values()].filter((v) => v.recording);
    const windows = new Set(sign.flatMap((v) => v.windowIds()));
    const outcome = await ops.stepAside(this, page, { windows, front: sign[0]?.page ?? null });
    this.log.info('agent window stepped aside', { outcome });
  }

  sharedWindows(): Promise<readonly SharedWindowInfo[]> {
    return ops.sharedWindows(this, this.views.values());
  }

  /** The window that holds `page`, or `null` when it cannot be read. */
  async windowOf(page: Page): Promise<number | null> {
    const targetId = this.dispatcher.targetIdOf(page);
    return targetId === undefined ? null : await this.targets.windowOf(targetId);
  }

  onCrash(listener: (reason: string) => void): () => void {
    return this.onExit((exit) => listener(exit.reason));
  }

  onExit(listener: (exit: TemplateHostExit) => void): () => void {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  browserPid(): Promise<number | null> {
    this.pid ??= this.closing ? Promise.resolve(null) : readBrowserPid(this.browser, this.log);
    return this.pid;
  }

  /** Closes the browser (only the supervisor calls this: idle stop, recycle, shutdown, delete). */
  close(deadlineMs: number, signal?: AbortSignal): Promise<readonly LaunchWarning[]> {
    this.closed ??= (async () => {
      this.closing = true;
      this.dispose();
      // A persistent context: closing it closes the browser too.
      await closeContextWithin(this.context, this.browser, deadlineMs, signal, this.log);
      return [];
    })();
    return this.closed;
  }

  /** The dispatcher committed an open page: resolve waiters, bound the parked pages. */
  private committed(page: Page, owner: PageOwner, facts: TargetFacts): void {
    // A session's page may open tabs Chromium gives no opener (modifier clicks): watch for them.
    if (owner.kind === 'session') void this.targets.watchNewTabs(page, facts.targetId);
    ops.deleteUnclaimedDownloads(page);
    ops.watchOrigins(page, this.origins);
    if (this.waiters.committed(page, owner, facts)) return;
    if (owner.kind !== 'parked' || page === this.keeper.page) return;
    this.parked.add(page, facts.targetId);
  }

  private exited(reason: string): void {
    if (this.closing) return;
    this.closing = true;
    const at = this.clock.now();
    const operatorStop = this.keeper.operatorStop(at);
    this.log.warn('template host exited', { reason, operatorStop });
    this.dispose();
    for (const listener of [...this.exitListeners]) {
      try {
        listener({ reason, operatorStop });
      } catch (err) {
        this.log.error('exit listener threw', { err: serializeError(err) });
      }
    }
  }

  private dispose(): void {
    this.dispatcher.dispose();
    this.waiters.cancelAll();
    void this.targets.dispose();
    void this.applied?.applier.dispose();
  }
}

/** `TEMPLATE_UNAVAILABLE` `starting` without the template name (the supervisor rewrites it). */
function unavailable(why: string, cause?: unknown): AppError<'INTERNAL_ERROR'> {
  return new AppError(
    'INTERNAL_ERROR',
    { ref: 'template-window' },
    { message: `template window failed: ${why}`, ...(cause !== undefined && { cause }) },
  );
}

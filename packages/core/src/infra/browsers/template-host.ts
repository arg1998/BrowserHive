/** @module infra/browsers/template-host — the shared browser of a template (spec 13 §3.1–§3.6): every page attributed before any session sees it, background windows claimed by target id, no window of its own (it starts with none, D-78), the parked-page bound, crash and operator-stop detection, and a close only the supervisor calls. */

import type { Browser, BrowserContext, Page } from 'patchright';
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
  ActivePageOf,
  PageHeap,
  TemplatePageWatcher as PageWatcher,
  ParkedPageInfo,
  SharedWindowInfo,
  SignInRemoval,
  TemplateHost,
  TemplateHostExit,
  TemplateViewOptions,
} from '../../ports/template-host.ts';
import type { TemplateState } from '../../ports/template-state.ts';
import { clipboardNeedsRestart } from './clipboard-policy.ts';
import { MinimizedWindows } from './headed-windows.ts';
import { OperatorCloseWatch } from './host-closes.ts';
import { closeContextWithin, readBrowserPid } from './host-process.ts';
import { observeHostResponses } from './host-responses.ts';
import type { IdentityApplier } from './identity-applier.ts';
import type { InterceptionChain } from './interception-chain.ts';
import { PARKED, type PageOwner, sessionOwner, type TargetFacts } from './page-attribution.ts';
import { HostPageDispatcher } from './page-dispatcher.ts';
import { pageSitesFileOf, watchPageSites } from './page-sites.ts';
import { PageWaiters } from './page-waiters.ts';
import { ParkedPages } from './parked-pages.ts';
import type { TemplateHostInput } from './template-host-input.ts';
import * as ops from './template-host-ops.ts';
import * as hostState from './template-host-state.ts';
import type { HostTargets } from './template-targets.ts';
import { TemplateSessionView, type TemplateViewHost } from './template-view.ts';

/** How long a created window may take to be adopted and attributed (spec 13 §3.3). */
export const ADOPTION_DEADLINE_MS = 10_000;
/** The close deadline of a host the operator quit while nobody listened for it. */
const OPERATOR_CLOSE_MS = 10_000;

export { CLOSE_BURST_MS } from './host-closes.ts';
export { MAX_PARKED_PAGES } from './parked-pages.ts';
export type { TemplateHostInput } from './template-host-input.ts';

/** A template host over a persistent context; built by the driver, held only by the supervisor. */
export class PlaywrightTemplateHost implements TemplateHost, TemplateViewHost {
  readonly hostId: string;
  readonly kind = 'template' as const;
  readonly browser: Browser | null;
  readonly context: BrowserContext;
  readonly capabilities: EngineCapabilities;
  readonly driver: 'patchright';
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
  /** Registrable domains a window opened as a page (top-level requests, redirect hops, popups). */
  private readonly topSites = new Set<string>();
  private readonly pageSitesWatch: ReturnType<typeof watchPageSites>;
  /** Origins whose data a sign-in removal cleared: never carried forward (spec 13 §3.9). */
  private readonly cleared = new Set<string>();
  private readonly userDataDir: string | null;
  private readonly pageWatcher: (() => PageWatcher | null) | null;
  private readonly exitListeners = new Set<(exit: TemplateHostExit) => void>();
  private applied: { identity: AppliedIdentity; applier: IdentityApplier } | null = null;
  /** Tells the operator quitting the browser from BrowserHive's own closes (D-78). */
  private readonly closeWatch: OperatorCloseWatch;
  /** Adopted pages by target id, with their owner, until Chromium destroys the target. */
  private readonly byTarget = new Map<string, { readonly page: Page; readonly owner: PageOwner }>();
  /** Agent windows of sessions whose windows stay minimized (`agent_windows`, D-77). */
  private readonly minimizedWindows: MinimizedWindows;
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
    this.pageWatcher = input.pageWatcher ?? null;
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
    this.closeWatch = new OperatorCloseWatch({
      clock: input.clock,
      log: this.log,
      closing: () => this.closing,
      livePageCount: () => this.targets.livePageCount(),
      closedByHost: (targetId) => this.targets.closedByHost(targetId),
      pageOf: (targetId) => {
        const known = this.byTarget.get(targetId);
        if (known === undefined) return undefined;
        const { owner } = known;
        const maintenance =
          owner.kind === 'session' && this.views.get(owner.sessionId)?.maintenance === true;
        return { page: known.page, maintenance };
      },
      operatorStop: (reason) => this.operatorStopped(reason),
    });
    this.minimizedWindows = new MinimizedWindows(this.targets, this.log, {
      now: () => input.clock.now(),
    });
    this.targets.onCreated(() => this.minimizedWindows.targetCreated());
    this.targets.onLostTarget((facts) => this.dispatcher.adoptClosedTarget(facts));
    this.targets.onDestroyed((targetId) => {
      this.closeWatch.targetDestroyed(targetId);
      this.byTarget.delete(targetId);
    });
    this.browser?.on('disconnected', () => this.exited('browser disconnected'));
    this.context.on('close', () => this.exited('context closed'));
    this.context.on('page', (page) => this.dispatcher.adopt(page));
    this.pageSitesWatch = watchPageSites(
      this.context,
      this.topSites,
      this.userDataDir === null ? null : pageSitesFileOf(this.userDataDir),
      this.log,
    );
    if (this.pageWatcher !== null) {
      observeHostResponses(this.context, this.hostId, this.pageWatcher, this.log);
    }
  }

  get identity(): AppliedIdentity | null {
    return this.applied?.identity ?? null;
  }

  /**
   * Pages present at start: none, since the host starts with no window (D-78); any there is
   * (a window Chromium restored) is closed before a session is admitted.
   */
  async adoptStartPages(): Promise<void> {
    const pages = this.context.pages();
    for (const page of pages) this.dispatcher.adopt(page);
    await Promise.all(
      pages.map((page) => page.close({ runBeforeUnload: false }).catch(() => undefined)),
    );
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
    if (this.closing) throw ops.windowUnavailable('host closing');
    const agent = options.maintenance !== true;
    const minimized =
      !this.headless &&
      (agent ? options.windowState === 'minimized' || this.recording : options.background === true);
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
      throw ops.windowUnavailable('window not created', err);
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
      throw ops.windowUnavailable(
        accepted ? 'window not adopted in time' : 'window parked before its claim',
      );
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

  clipboardNeedsRestart(): boolean {
    return clipboardNeedsRestart(this.context);
  }

  parkedPages(): readonly ParkedPageInfo[] {
    return this.parked.list();
  }

  async jar(): Promise<readonly Cookie[]> {
    return await this.context.cookies();
  }

  async storageState(): Promise<TemplateState> {
    return await hostState.readStorageState(this.context);
  }

  async setStorageState(state: TemplateState): Promise<void> {
    await hostState.applyStorageState(this.context, state);
    for (const origin of state.origins) this.origins.add(origin.origin);
  }

  pageSites(): ReadonlySet<string> {
    return this.topSites;
  }

  visitedOrigins(): ReadonlySet<string> {
    return new Set([...this.origins, ...this.cleared]);
  }

  pageHeaps(activeOf?: ActivePageOf): Promise<readonly PageHeap[]> {
    return hostState.pageHeaps(this.context, this.dispatcher, this.views.values(), this.log, {
      activeOf,
    });
  }

  closePage(targetId: string, scope: 'parked' | 'session'): Promise<boolean> {
    const parked = this.parked.pageOf(targetId);
    const pages =
      scope === 'parked'
        ? parked === undefined
          ? []
          : [parked]
        : [...this.views.values()].filter((v) => !v.maintenance).flatMap((v) => v.pages());
    return hostState.closePageByTarget(this.dispatcher, pages, targetId, this.log);
  }

  async clearSignIn(domain: string): Promise<SignInRemoval> {
    // `Storage.clearDataForOrigin` needs a page target's session (the browser-level one answers
    // "Internal error", measured on Chromium 153); it acts on the profile, not on the page. A host
    // with no window (D-78) gets a parked background window for it, closed right after.
    const open = this.context.pages().find((p) => !p.isClosed());
    const own = open === undefined ? await this.openWindow(null, !this.headless) : null;
    const page = open ?? own;
    try {
      const removal = await ops.clearSignIn(
        {
          context: this.context,
          dispatcher: this.dispatcher,
          targets: this.targets,
          committedOrigins: this.origins,
          userDataDir: this.userDataDir,
          log: this.log,
          storageSession: () =>
            page === null ? Promise.reject(new Error('no page')) : this.context.newCDPSession(page),
        },
        domain,
      );
      for (const origin of removal.origins) this.cleared.add(origin);
      return removal;
    } finally {
      await own?.close({ runBeforeUnload: false }).catch(() => undefined);
    }
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

  /**
   * A page of a session whose windows stay minimized: its window is minimized unless the operator
   * restored that window by hand (a tab a site opened restores it, a popup opens normal, D-77).
   */
  async keepMinimized(page: Page): Promise<void> {
    if (this.headless) return;
    const targetId = this.dispatcher.targetIdOf(page);
    if (targetId !== undefined) await this.minimizedWindows.pageOpened(targetId);
  }

  /** Runs a tool call on `pages`; their windows it restored are minimized again (D-77). */
  keepMinimizedAround<T>(pages: readonly Page[], run: () => Promise<T>): Promise<T> {
    if (this.headless) return run();
    const targets = async () =>
      pages.flatMap((page) => {
        const targetId = this.dispatcher.targetIdOf(page);
        return targetId === undefined ? [] : [targetId];
      });
    return this.minimizedWindows.around(targets, run);
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
      await this.pageSitesWatch.flush();
      // A persistent context: closing it closes the browser too.
      await closeContextWithin(this.context, this.browser, deadlineMs, signal, this.log);
      return [];
    })();
    return this.closed;
  }

  /** The dispatcher committed an open page: resolve waiters, bound the parked pages. */
  private committed(page: Page, owner: PageOwner, facts: TargetFacts): void {
    // A session's page may open tabs Chromium gives no opener (modifier clicks): watch for them.
    if (owner.kind === 'session') {
      void this.targets.watchNewTabs(page, facts.targetId);
      ops.watchPage(this.pageWatcher?.() ?? null, this.hostId, page, owner.sessionId, this.log);
    }
    ops.deleteUnclaimedDownloads(page);
    ops.watchOrigins(page, this.origins);
    // A popup's first request can precede the context's listener seeing its page (review #85 M4).
    this.pageSitesWatch.record(page.url());
    this.byTarget.set(facts.targetId, { page, owner });
    if (this.waiters.committed(page, owner, facts)) return;
    if (owner.kind !== 'parked') return;
    this.parked.add(page, facts.targetId);
  }

  /**
   * The browser went away without BrowserHive closing it: a crash or a kill (its pipe closed). After
   * an operator stop the supervisor is already closing the browser, so its exit is not reported.
   */
  private exited(reason: string): void {
    if (this.closing) return;
    this.closing = true;
    this.dispose();
    if (this.closeWatch.stopped) return;
    this.log.warn('template host exited', { reason, operatorStop: false });
    this.notifyExit({ reason, operatorStop: false });
  }

  /**
   * The operator quit the browser (its last window closed by hand, or the menu's Exit): Chromium
   * keeps the process with no window, so the supervisor stops the host cleanly (sessions closed
   * `operator`, a checkpoint, then the browser). Without a listener the host closes itself.
   */
  private operatorStopped(reason: string): void {
    this.log.info('host stopped by operator', { reason });
    if (this.exitListeners.size === 0) {
      void this.close(OPERATOR_CLOSE_MS);
      return;
    }
    this.notifyExit({ reason, operatorStop: true });
  }

  private notifyExit(exit: TemplateHostExit): void {
    for (const listener of [...this.exitListeners]) {
      try {
        listener(exit);
      } catch (err) {
        this.log.error('exit listener threw', { err: serializeError(err) });
      }
    }
  }

  private dispose(): void {
    this.minimizedWindows.dispose();
    this.dispatcher.dispose();
    this.waiters.cancelAll();
    void this.targets.dispose();
    void this.applied?.applier.dispose();
  }
}

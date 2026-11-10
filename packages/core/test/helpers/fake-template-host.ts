/** @module test/helpers/fake-template-host — a scriptable `TemplateHost` and `TemplateHostLauncher` for the supervisor suites: views are `FakeSessionView`s, exits and start failures are triggered by the test. */

import type { BrowserContext } from 'playwright';
import type {
  AppliedIdentity,
  Cookie,
  EngineCapabilities,
  LaunchWarning,
  SessionView,
} from '../../src/ports/browser-driver.ts';
import type {
  PageHeap,
  ParkedPageInfo,
  SharedWindowInfo,
  SignInRemoval,
  TemplateHost,
  TemplateHostExit,
  TemplateHostLauncher,
  TemplateHostSpec,
  TemplateViewOptions,
} from '../../src/ports/template-host.ts';
import type { TemplateState } from '../../src/ports/template-state.ts';
import { FakeSessionView } from './fake-session-view.ts';

const CAPABILITIES: EngineCapabilities = {
  cdpScreencast: true,
  pdf: true,
  trace: false,
  closedShadowRoot: false,
  perContextProxy: true,
  isolatedEvaluate: false,
};

/** A template host whose views are fakes; `exit()` plays a crash or an operator stop. */
export class FakeTemplateHost implements TemplateHost {
  readonly hostId: string;
  readonly kind = 'template' as const;
  readonly browser = null;
  readonly context = {} as BrowserContext;
  readonly capabilities = CAPABILITIES;
  readonly driver = 'playwright' as const;
  readonly identity: AppliedIdentity | null;
  readonly warnings: readonly LaunchWarning[] = [];
  readonly tracing = null;
  readonly views = new Map<string, FakeSessionView>();
  readonly viewOptions = new Map<string, TemplateViewOptions>();
  parked: ParkedPageInfo[] = [];
  closed = 0;
  /** Extra pages per session (beyond each view's first page), for the cap checks. */
  readonly extraPages = new Map<string, number>();
  failOpen: Error | null = null;
  /** Exit listeners (the supervisor's, and one per open view, like the real host). */
  readonly exits = new Set<(exit: TemplateHostExit) => void>();
  profileSecrets = false;
  /** The template's jar as the test scripts it. */
  cookies: Cookie[] = [];
  /** Domains whose sign-in was removed, in order. */
  readonly cleared: string[] = [];
  shared: SharedWindowInfo[] = [];
  /** The storage origins of the fake jar (`storageState`, `setStorageState`). */
  origins: TemplateState['origins'] = [];
  /** Origins the "process" visited (carry-forward). */
  readonly visited = new Set<string>();
  /** States applied with `setStorageState`, in order. */
  readonly applied: TemplateState[] = [];
  /** Agent page heaps the memory trim reads. */
  heaps: PageHeap[] = [];
  /** Pages closed by target id, with their scope. */
  readonly closedPages: { targetId: string; scope: 'parked' | 'session' }[] = [];
  /** When set, `storageState` fails with it. */
  failState: Error | null = null;

  constructor(templateId: string, identity: AppliedIdentity | null = null) {
    this.hostId = templateId;
    this.identity = identity;
  }

  async openView(sessionId: string, options: TemplateViewOptions): Promise<SessionView> {
    if (this.failOpen !== null) throw this.failOpen;
    const view = new FakeSessionView(sessionId);
    this.views.set(sessionId, view);
    this.viewOptions.set(sessionId, options);
    // Like `TemplateSessionView`: a view's crash listeners are host exit listeners that skip an
    // operator stop, and they go when the view closes.
    const subscriptions = new Set<() => void>();
    view.onCrash = (listener) => {
      const off = this.onExit((exit) => {
        if (!exit.operatorStop) listener(exit.reason);
      });
      subscriptions.add(off);
      return off;
    };
    const close = view.close.bind(view);
    view.close = async (deadline, signal) => {
      for (const off of subscriptions) off();
      this.views.delete(sessionId);
      return close(deadline, signal);
    };
    return view;
  }

  /** Runs the session's `beforeNewPage` check, then counts one more page. */
  newPage(sessionId: string): void {
    this.viewOptions.get(sessionId)?.beforeNewPage?.();
    this.extraPages.set(sessionId, (this.extraPages.get(sessionId) ?? 0) + 1);
  }

  agentPageCount(): number {
    let n = 0;
    for (const id of this.views.keys()) {
      if (this.viewOptions.get(id)?.maintenance !== true) n += this.sessionPageCount(id);
    }
    return n;
  }

  sessionPageCount(sessionId: string): number {
    return this.views.has(sessionId) ? 1 + (this.extraPages.get(sessionId) ?? 0) : 0;
  }

  parkedPages(): readonly ParkedPageInfo[] {
    return this.parked;
  }

  viewIds(): readonly string[] {
    return [...this.views.keys()];
  }

  ensureIdentityForPage(): Promise<void> {
    return Promise.resolve();
  }

  onExit(listener: (exit: TemplateHostExit) => void): () => void {
    this.exits.add(listener);
    return () => {
      this.exits.delete(listener);
    };
  }

  onCrash(listener: (reason: string) => void): () => void {
    return this.onExit((exit) => listener(exit.reason));
  }

  /** The browser went away: every exit listener runs, as on the real host. */
  exit(exit: TemplateHostExit = { reason: 'browser disconnected', operatorStop: false }): void {
    for (const listener of [...this.exits]) listener(exit);
  }

  async close(): Promise<readonly LaunchWarning[]> {
    this.closed += 1;
    return [];
  }

  browserPid(): Promise<number | null> {
    return Promise.resolve(4242);
  }

  async jar(): Promise<readonly Cookie[]> {
    return [...this.cookies];
  }

  async clearSignIn(domain: string): Promise<SignInRemoval> {
    this.cleared.push(domain);
    const before = this.cookies.length;
    this.cookies = this.cookies.filter(
      (c) => !`.${c.domain.replace(/^\./, '')}`.endsWith(`.${domain}`),
    );
    return { cookiesRemoved: before - this.cookies.length, origins: [], unclearedOrigins: [] };
  }

  async sharedWindows(): Promise<readonly SharedWindowInfo[]> {
    return this.shared;
  }

  async storageState(): Promise<TemplateState> {
    if (this.failState !== null) throw this.failState;
    return {
      cookies: this.cookies.map((c) => ({ ...c, sameSite: c.sameSite })),
      origins: this.origins,
    };
  }

  async setStorageState(state: TemplateState): Promise<void> {
    this.applied.push(state);
    this.cookies = state.cookies.map((c) => ({ ...c }));
    this.origins = state.origins;
    for (const o of state.origins) this.visited.add(o.origin);
  }

  visitedOrigins(): ReadonlySet<string> {
    return this.visited;
  }

  async pageHeaps(): Promise<readonly PageHeap[]> {
    return this.heaps.filter((h) => this.views.has(h.sessionId));
  }

  async closePage(targetId: string, scope: 'parked' | 'session'): Promise<boolean> {
    if (scope === 'parked') {
      const before = this.parked.length;
      this.parked = this.parked.filter((p) => p.targetId !== targetId);
      if (this.parked.length === before) return false;
    } else {
      const heap = this.heaps.find((h) => h.targetId === targetId);
      if (heap === undefined) return false;
      this.heaps = this.heaps.filter((h) => h !== heap);
    }
    this.closedPages.push({ targetId, scope });
    return true;
  }
}

/** A cookie for {@link FakeTemplateHost.cookies}. */
export function fakeCookie(domain: string, name: string, value = `${name}-value-000000`): Cookie {
  return {
    name,
    value,
    domain,
    path: '/',
    expires: 2_000_000_000,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  };
}

/** A launcher whose starts the test scripts: resolve now, fail, or hold until released. */
export class FakeTemplateLauncher implements TemplateHostLauncher {
  readonly specs: TemplateHostSpec[] = [];
  readonly hosts: FakeTemplateHost[] = [];
  /** Errors the next starts fail with, in order. */
  readonly failures: Error[] = [];
  /** When set, starts wait for `release()`. */
  hold = false;
  identity: AppliedIdentity | null = null;
  private waiting: Array<() => void> = [];

  async launchTemplateHost(spec: TemplateHostSpec): Promise<TemplateHost> {
    this.specs.push(spec);
    if (this.hold) await new Promise<void>((resolve) => this.waiting.push(resolve));
    const failure = this.failures.shift();
    if (failure !== undefined) throw failure;
    const host = new FakeTemplateHost(spec.templateId, this.identity);
    this.hosts.push(host);
    return host;
  }

  /** Lets held starts proceed. */
  release(): void {
    this.hold = false;
    for (const resolve of this.waiting.splice(0)) resolve();
  }

  get last(): FakeTemplateHost {
    const host = this.hosts.at(-1);
    if (host === undefined) throw new Error('no host started');
    return host;
  }
}

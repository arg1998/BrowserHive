/** @module test/helpers/fake-template-host — a scriptable `TemplateHost` and `TemplateHostLauncher` for the supervisor suites: views are `FakeSessionView`s, exits and start failures are triggered by the test. */

import type { BrowserContext } from 'playwright';
import type {
  AppliedIdentity,
  EngineCapabilities,
  LaunchWarning,
  SessionView,
} from '../../src/ports/browser-driver.ts';
import type {
  ParkedPageInfo,
  TemplateHost,
  TemplateHostExit,
  TemplateHostLauncher,
  TemplateHostSpec,
  TemplateViewOptions,
} from '../../src/ports/template-host.ts';
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
  private readonly exits = new Set<(exit: TemplateHostExit) => void>();

  constructor(templateId: string, identity: AppliedIdentity | null = null) {
    this.hostId = templateId;
    this.identity = identity;
  }

  async openView(sessionId: string, options: TemplateViewOptions): Promise<SessionView> {
    if (this.failOpen !== null) throw this.failOpen;
    const view = new FakeSessionView(sessionId);
    this.views.set(sessionId, view);
    this.viewOptions.set(sessionId, options);
    const close = view.close.bind(view);
    view.close = async (deadline, signal) => {
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

  /** The browser went away: listeners first (the supervisor), then each view's crash fan-out. */
  exit(exit: TemplateHostExit = { reason: 'browser disconnected', operatorStop: false }): void {
    for (const listener of [...this.exits]) listener(exit);
    if (!exit.operatorStop) for (const view of this.views.values()) view.crash(exit.reason);
  }

  async close(): Promise<readonly LaunchWarning[]> {
    this.closed += 1;
    return [];
  }

  browserPid(): Promise<number | null> {
    return Promise.resolve(4242);
  }
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

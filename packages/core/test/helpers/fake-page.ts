/** @module test/helpers/fake-page — FakePage: the Playwright `Page` subset the tools use, with scripted outcomes and call recording (spec 09 §4). */

import type { Page } from 'playwright';

/** One recorded call. */
export interface RecordedCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

/** Scripted outcomes; mutate between calls. */
export interface PageScript {
  /** Title returned by `title()`. */
  title: string;
  /** `content()` HTML. */
  html: string;
  /** Result of `evaluate()`. */
  evaluateResult: unknown;
  /** Methods that throw on their next call (consumed once per entry unless `sticky`). */
  readonly failures: Map<string, { error: unknown; sticky: boolean }>;
}

type Listener = (payload: unknown) => void;

/** A minimal dialog the `dialog` listeners receive. */
export interface FakeDialog {
  readonly type: string;
  readonly message: string;
  accept(promptText?: string): Promise<void>;
  dismiss(): Promise<void>;
  readonly outcome: { accepted: boolean | null; promptText: string | undefined };
}

/** A minimal download the `download` listeners receive. */
export interface FakeDownload {
  suggestedFilename(): string;
  saveAs(path: string): Promise<void>;
  readonly savedTo: string | null;
}

/**
 * The single sanctioned structural cast for test doubles: a {@link FakePage} implements the
 * subset of `Page` the tools call, and Playwright's full surface (hundreds of members) is not
 * worth faking. Every other place that needs a `Page` from a fake goes through this function.
 */
export function asPage(fake: FakePage): Page {
  const widened: unknown = fake;
  return widened as Page;
}

/** In-memory Playwright page. Every method records itself in `calls`. */
export class FakePage {
  readonly calls: RecordedCall[] = [];
  readonly script: PageScript = {
    title: '',
    html: '<html></html>',
    evaluateResult: undefined,
    failures: new Map(),
  };
  readonly keyboard = {
    press: (key: string, options?: unknown): Promise<void> =>
      this.run('keyboard.press', [key, options]),
    type: (text: string, options?: unknown): Promise<void> =>
      this.run('keyboard.type', [text, options]),
  };
  readonly mouse = {
    move: (x: number, y: number, options?: unknown): Promise<void> =>
      this.run('mouse.move', [x, y, options]),
    click: (x: number, y: number, options?: unknown): Promise<void> =>
      this.run('mouse.click', [x, y, options]),
    wheel: (dx: number, dy: number): Promise<void> => this.run('mouse.wheel', [dx, dy]),
    down: (): Promise<void> => this.run('mouse.down', []),
    up: (): Promise<void> => this.run('mouse.up', []),
  };
  private currentUrl: string;
  private closed = false;
  private viewport: { width: number; height: number } | null = { width: 1280, height: 720 };
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly onceListeners = new Map<string, Set<Listener>>();
  private readonly owner: unknown;

  constructor(url = 'about:blank', context?: unknown) {
    this.currentUrl = url;
    this.owner = context ?? null;
  }

  /** This fake typed as a Playwright `Page` (via {@link asPage}). */
  get page(): Page {
    return asPage(this);
  }

  /** Schedules `error` for the next call of `method` (`sticky` keeps failing). */
  failWith(method: string, error: unknown, sticky = false): void {
    this.script.failures.set(method, { error, sticky });
  }

  /** Names of recorded calls, in order. */
  methods(): string[] {
    return this.calls.map((c) => c.method);
  }

  // --- navigation and reads --------------------------------------------------------------------

  url(): string {
    this.record('url', []);
    if (this.closed) throw new Error('Target page, context or browser has been closed');
    return this.currentUrl;
  }

  async title(): Promise<string> {
    await this.run('title', []);
    return this.script.title;
  }

  async goto(url: string, options?: unknown): Promise<{ status(): number; url(): string } | null> {
    await this.run('goto', [url, options]);
    this.currentUrl = url;
    return { status: () => 200, url: () => url };
  }

  async content(): Promise<string> {
    await this.run('content', []);
    return this.script.html;
  }

  async evaluate(expression: unknown, arg?: unknown): Promise<unknown> {
    await this.run('evaluate', [expression, arg]);
    return this.script.evaluateResult;
  }

  async screenshot(options?: unknown): Promise<Buffer> {
    await this.run('screenshot', [options]);
    return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  }

  // --- interaction -----------------------------------------------------------------------------

  click(selector: string, options?: unknown): Promise<void> {
    return this.run('click', [selector, options]);
  }

  fill(selector: string, value: string, options?: unknown): Promise<void> {
    return this.run('fill', [selector, value, options]);
  }

  type(selector: string, text: string, options?: unknown): Promise<void> {
    return this.run('type', [selector, text, options]);
  }

  press(selector: string, key: string, options?: unknown): Promise<void> {
    return this.run('press', [selector, key, options]);
  }

  hover(selector: string, options?: unknown): Promise<void> {
    return this.run('hover', [selector, options]);
  }

  async selectOption(selector: string, values: unknown, options?: unknown): Promise<string[]> {
    await this.run('selectOption', [selector, values, options]);
    return Array.isArray(values) ? values.filter((v): v is string => typeof v === 'string') : [];
  }

  dragAndDrop(source: string, target: string, options?: unknown): Promise<void> {
    return this.run('dragAndDrop', [source, target, options]);
  }

  async waitForSelector(selector: string, options?: unknown): Promise<null> {
    await this.run('waitForSelector', [selector, options]);
    return null;
  }

  waitForLoadState(state?: string, options?: unknown): Promise<void> {
    return this.run('waitForLoadState', [state, options]);
  }

  bringToFront(): Promise<void> {
    return this.run('bringToFront', []);
  }

  async setViewportSize(size: { width: number; height: number }): Promise<void> {
    await this.run('setViewportSize', [size]);
    this.viewport = { ...size };
  }

  viewportSize(): { width: number; height: number } | null {
    this.record('viewportSize', []);
    return this.viewport;
  }

  setExtraHTTPHeaders(headers: Record<string, string>): Promise<void> {
    return this.run('setExtraHTTPHeaders', [headers]);
  }

  locator(selector: string): { readonly selector: string; count(): Promise<number> } {
    this.record('locator', [selector]);
    return { selector, count: async () => 1 };
  }

  context(): unknown {
    this.record('context', []);
    return this.owner;
  }

  // --- lifecycle -------------------------------------------------------------------------------

  async close(): Promise<void> {
    await this.run('close', []);
    if (this.closed) return;
    this.closed = true;
    this.emit('close', this);
  }

  isClosed(): boolean {
    return this.closed;
  }

  // --- events ----------------------------------------------------------------------------------

  on(event: string, listener: Listener): this {
    const set = this.listeners.get(event) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(event, set);
    return this;
  }

  once(event: string, listener: Listener): this {
    const set = this.onceListeners.get(event) ?? new Set<Listener>();
    set.add(listener);
    this.onceListeners.set(event, set);
    return this;
  }

  off(event: string, listener: Listener): this {
    this.listeners.get(event)?.delete(listener);
    this.onceListeners.get(event)?.delete(listener);
    return this;
  }

  /** Delivers `payload` to every listener of `event`; `once` listeners are consumed. */
  emit(event: string, payload: unknown): number {
    const persistent = [...(this.listeners.get(event) ?? [])];
    const single = [...(this.onceListeners.get(event) ?? [])];
    this.onceListeners.delete(event);
    for (const listener of [...persistent, ...single]) listener(payload);
    return persistent.length + single.length;
  }

  /** Emits a scripted dialog and returns it so the test can inspect the outcome. */
  emitDialog(type = 'alert', message = ''): FakeDialog {
    const outcome: { accepted: boolean | null; promptText: string | undefined } = {
      accepted: null,
      promptText: undefined,
    };
    const dialog: FakeDialog = {
      type,
      message,
      outcome,
      accept: async (promptText) => {
        outcome.accepted = true;
        outcome.promptText = promptText;
      },
      dismiss: async () => {
        outcome.accepted = false;
      },
    };
    this.emit('dialog', dialog);
    return dialog;
  }

  /** Emits a scripted download and returns it. */
  emitDownload(suggestedName = 'file.bin'): FakeDownload {
    let savedTo: string | null = null;
    const download: FakeDownload = {
      suggestedFilename: () => suggestedName,
      saveAs: async (path) => {
        savedTo = path;
      },
      get savedTo() {
        return savedTo;
      },
    };
    this.emit('download', download);
    return download;
  }

  // --- internals -------------------------------------------------------------------------------

  private record(method: string, args: readonly unknown[]): void {
    this.calls.push({ method, args });
  }

  private async run(method: string, args: readonly unknown[]): Promise<void> {
    this.record(method, args);
    const failure = this.script.failures.get(method);
    if (failure !== undefined) {
      if (!failure.sticky) this.script.failures.delete(method);
      throw failure.error;
    }
  }
}

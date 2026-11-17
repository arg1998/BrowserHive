/** @module test/helpers/fake-pack-page — a scripted Patchright `Page` for the site pack page enforcement's unit tests: locators are expressions (`(a & b)`, `(a | b)`, `a >> b`, `role=button[Name]`, `text=…`) whose `count()` a test answers, plus events, frames, `route` and `goto`. Real DOM semantics are pinned by the integration suites. */

import type { Page } from 'patchright';

/** A locator over an expression. */
export class FakeLocator {
  constructor(
    readonly expr: string,
    private readonly page: FakePackPage,
  ) {}

  and(other: FakeLocator): FakeLocator {
    return new FakeLocator(`(${this.expr} & ${other.expr})`, this.page);
  }

  or(other: FakeLocator): FakeLocator {
    return new FakeLocator(`(${this.expr} | ${other.expr})`, this.page);
  }

  locator(selector: string): FakeLocator {
    return new FakeLocator(`${this.expr} >> ${selector}`, this.page);
  }

  async count(): Promise<number> {
    this.page.queries.push(this.expr);
    return this.page.count(this.expr);
  }
}

/** A frame of the fake page. */
export interface FakeFrame {
  url(): string;
  isDetached(): boolean;
  waitForLoadState(): Promise<void>;
  frameElement(): Promise<{
    isVisible(): Promise<boolean>;
    boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>;
    dispose(): Promise<void>;
  }>;
}

/** A child frame with a box. */
export function fakeFrame(
  url: string,
  box: { x: number; y: number; width: number; height: number } | null,
  visible = true,
): FakeFrame {
  return {
    url: () => url,
    isDetached: () => false,
    waitForLoadState: async () => undefined,
    frameElement: async () => ({
      isVisible: async () => visible,
      boundingBox: async () => box,
      dispose: async () => undefined,
    }),
  };
}

type Listener = (arg: unknown) => void;

/** The scripted page. */
export class FakePackPage {
  currentUrl = 'about:blank';
  pageTitle = '';
  /** Answers `count()` for an expression (default 0). */
  count: (expr: string) => number = () => 0;
  readonly queries: string[] = [];
  readonly main: FakeFrame = {
    ...fakeFrame('about:blank', null),
    url: () => this.currentUrl,
  };
  children: FakeFrame[] = [];
  closed = false;
  /** `goto`: what the navigation does (default: commits the URL, status 200). */
  onGoto: (url: string) => Promise<{ status: number } | null> = async (url) => {
    this.currentUrl = url;
    return { status: 200 };
  };
  readonly routes: { pattern: string; handler: (route: unknown) => unknown }[] = [];
  readonly gotos: string[] = [];
  readonly #listeners = new Map<string, Listener[]>();

  url(): string {
    return this.currentUrl;
  }
  async title(): Promise<string> {
    return this.pageTitle;
  }
  isClosed(): boolean {
    return this.closed;
  }
  viewportSize(): { width: number; height: number } | null {
    return { width: 1280, height: 800 };
  }
  mainFrame(): FakeFrame {
    return this.main;
  }
  frames(): FakeFrame[] {
    return [this.main, ...this.children];
  }
  locator(selector: string): FakeLocator {
    return new FakeLocator(selector, this);
  }
  getByRole(role: string, options: { name: string }): FakeLocator {
    return new FakeLocator(`role=${role}[${options.name}]`, this);
  }
  getByText(text: string): FakeLocator {
    return new FakeLocator(`text=${text}`, this);
  }
  on(event: string, listener: Listener): void {
    this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), listener]);
  }
  emit(event: string, arg?: unknown): void {
    for (const listener of this.#listeners.get(event) ?? []) listener(arg);
  }
  /** Commits `url` in the main frame (`framenavigated`, then `domcontentloaded`). */
  commit(url: string, title = ''): void {
    this.currentUrl = url;
    this.pageTitle = title;
    this.emit('framenavigated', this.main);
    this.emit('domcontentloaded');
  }
  async route(pattern: string, handler: (route: unknown) => unknown): Promise<void> {
    this.routes.push({ pattern, handler });
  }
  async goto(url: string): Promise<{ status(): number } | null> {
    this.gotos.push(url);
    const response = await this.onGoto(url);
    return response === null ? null : { status: () => response.status };
  }
  async waitForLoadState(): Promise<void> {
    return undefined;
  }

  /** This fake as the driver's `Page` type (only the members above are used). */
  asPage(): Page {
    return this as unknown as Page;
  }
}

/** Lets queued microtasks and promise chains settle. */
export async function settle(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

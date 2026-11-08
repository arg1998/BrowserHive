/** @module test/helpers/tool-fakes — Playwright surface the tools call that `FakePage`/`FakeBrowserContext` do not model (history, locators, cookies, files, downloads), installed per launched handle. */

import { createPlaywrightPageActions } from '../../src/infra/browsers/page-actions.ts';
import type { PageActions } from '../../src/ports/page-actions.ts';
import type { FakePage } from './fake-page.ts';
import type { FakeBrowserContext, FakeSessionHandle } from './fake-session-handle.ts';

/** Scripted outcomes for the extended surface (mutable per test). */
export interface ToolFakeScript {
  /** `goto` response status (default 200). */
  status: number;
  /** `ariaSnapshot()` text. */
  aria: string;
  /** Cookies `context.cookies()` answers with. */
  cookies: Record<string, unknown>[];
  /** Name of the download `waitForEvent('download')` yields. */
  downloadName: string;
  /** Bytes written by `download.saveAs`. */
  downloadBody: string;
  /** Headers applied through `setExtraHTTPHeaders`. */
  headers: Record<string, string> | null;
  /** Paths applied through `setInputFiles`. */
  inputFiles: string[];
  /** What BrowserHive's own text read answers (the CDP isolated world or `locator.evaluate`). */
  readText: string;
  /** What BrowserHive's own `outerHTML` read answers. */
  readHtml: string;
  /** `locator(selector).count()` per selector (default 1). */
  counts: Record<string, number>;
}

/** A fresh script with neutral defaults. */
export function toolFakeScript(): ToolFakeScript {
  return {
    status: 200,
    aria: '- heading "fixture" [level=1]',
    cookies: [],
    downloadName: 'fixture.txt',
    downloadBody: 'fixture download body\n',
    headers: null,
    inputFiles: [],
    readText: 'fixture text',
    readHtml: '<p>fixture</p>',
    counts: {},
  };
}

/** The page-side reader's answer for the scripted read (`kind` from the serialised argument). */
function readAnswer(script: ToolFakeScript, kind: string): { status: 'ok'; value: string } {
  return { status: 'ok', value: kind === 'outer_html' ? script.readHtml : script.readText };
}

/** A CDP session answering the three calls of BrowserHive's isolated-world read. */
function fakeCdp(page: FakePage, script: ToolFakeScript): Record<string, unknown> {
  return {
    send: async (method: string, params?: { expression?: string }) => {
      record(page, `cdp:${method}`, [params]);
      await maybeFail(page, `cdp:${method}`);
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
      const kind = params?.expression?.includes('"kind":"outer_html"') ? 'outer_html' : 'text';
      return { result: { value: readAnswer(script, kind) } };
    },
    detach: async () => undefined,
  };
}

function record(page: FakePage, method: string, args: readonly unknown[]): void {
  page.calls.push({ method, args });
}

async function maybeFail(page: FakePage, method: string): Promise<void> {
  const failure = page.script.failures.get(method);
  if (failure === undefined) return;
  if (!failure.sticky) page.script.failures.delete(method);
  throw failure.error;
}

/** Adds the missing page methods to one fake page. */
export function extendPage(page: FakePage, script: ToolFakeScript): FakePage {
  const baseGoto = page.goto.bind(page);
  const baseLocator = page.locator.bind(page);
  Object.assign(page, {
    goto: async (url: string, options?: unknown) => {
      await baseGoto(url, options);
      const status = script.status;
      return { status: () => status, url: () => url };
    },
    goBack: async (options?: unknown) => {
      record(page, 'goBack', [options]);
      await maybeFail(page, 'goBack');
      return null;
    },
    goForward: async (options?: unknown) => {
      record(page, 'goForward', [options]);
      await maybeFail(page, 'goForward');
      return null;
    },
    reload: async (options?: unknown) => {
      record(page, 'reload', [options]);
      await maybeFail(page, 'reload');
      return null;
    },
    waitForURL: async (url: unknown, options?: unknown) => {
      record(page, 'waitForURL', [url, options]);
      await maybeFail(page, 'waitForURL');
    },
    waitForTimeout: async (ms: number) => record(page, 'waitForTimeout', [ms]),
    $eval: async (selector: string, fn: (el: unknown) => unknown) => {
      record(page, '$eval', [selector]);
      return fn({ form: null });
    },
    setInputFiles: async (selector: string, files: string[], options?: unknown) => {
      record(page, 'setInputFiles', [selector, files, options]);
      await maybeFail(page, 'setInputFiles');
      script.inputFiles = [...files];
    },
    waitForEvent: async (event: string, options?: unknown) => {
      record(page, 'waitForEvent', [event, options]);
      await maybeFail(page, 'waitForEvent');
      return {
        suggestedFilename: () => script.downloadName,
        saveAs: async (path: string) => {
          await Bun.write(path, script.downloadBody);
        },
      };
    },
    locator: (selector: string) => {
      const base = baseLocator(selector);
      const ariaSnapshot = async (options?: unknown) => {
        record(page, 'ariaSnapshot', [selector, options]);
        await maybeFail(page, 'ariaSnapshot');
        return script.aria;
      };
      const evaluate = async (_fn: unknown, arg: { kind?: string } | undefined) => {
        record(page, 'locator.evaluate', [selector, arg]);
        await maybeFail(page, 'locator.evaluate');
        return readAnswer(script, arg?.kind ?? 'text');
      };
      return {
        ...base,
        count: async () => {
          record(page, 'count', [selector]);
          await maybeFail(page, 'count');
          return script.counts[selector] ?? 1;
        },
        first: () => ({ ariaSnapshot, evaluate }),
        evaluate,
        scrollIntoViewIfNeeded: async (options?: unknown) => {
          record(page, 'scrollIntoViewIfNeeded', [selector, options]);
          await maybeFail(page, 'scrollIntoViewIfNeeded');
        },
        boundingBox: async () => ({ x: 10, y: 10, width: 100, height: 20 }),
        ariaSnapshot,
      };
    },
  });
  return page;
}

/** Adds the missing context methods (cookies, headers, storage state) and extends every page. */
export function extendContext(context: FakeBrowserContext, script: ToolFakeScript): void {
  for (const page of context.fakePages) extendPage(page, script);
  const baseAddPage = context.addPage.bind(context);
  Object.assign(context, {
    addPage: (url?: string) => extendPage(baseAddPage(url), script),
    // `asPage(fake)` is the fake itself, so the target page is the FakePage that records the calls.
    newCDPSession: async (target: FakePage) => fakeCdp(target, script),
    cookies: async (urls?: string[]) => {
      void urls;
      return script.cookies.map((c) => ({ ...c }));
    },
    addCookies: async (cookies: Record<string, unknown>[]) => {
      for (const cookie of cookies) {
        if (cookie['url'] === undefined && cookie['domain'] === undefined) {
          throw new Error(
            'browserContext.addCookies: Cookie should have a url or a domain/path pair',
          );
        }
        script.cookies.push({ ...cookie });
      }
    },
    setExtraHTTPHeaders: async (headers: Record<string, string>) => {
      script.headers = { ...headers };
    },
    storageState: async (options: { path: string }) => {
      await Bun.write(options.path, JSON.stringify({ cookies: script.cookies, origins: [] }));
      return { cookies: script.cookies, origins: [] };
    },
  });
}

/** Installs the extensions on a launched fake handle. */
export function extendHandle(handle: FakeSessionHandle, script: ToolFakeScript): void {
  extendContext(handle.fakeContext, script);
}

/** Real page actions with humanize calls recorded and short-circuited to the native call. */
export function spyPageActions(): { actions: PageActions; calls: string[] } {
  const real = createPlaywrightPageActions();
  const calls: string[] = [];
  return {
    calls,
    actions: {
      ...real,
      humanClick: async (_id, input) => {
        calls.push('humanClick');
        await input.native();
      },
      humanHover: async (_id, input) => {
        calls.push('humanHover');
        await input.native();
      },
      humanType: async (_id, input) => {
        calls.push(`humanType:${input.timeout}`);
        await input.native();
      },
      humanScroll: async () => {
        calls.push('humanScroll');
      },
      invalidateCursor: (id, page) => {
        calls.push('invalidateCursor');
        real.invalidateCursor(id, page);
      },
    },
  };
}

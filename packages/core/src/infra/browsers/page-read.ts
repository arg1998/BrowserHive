/** @module infra/browsers/page-read — BrowserHive's own DOM reads (`get_text`, `get_content {selector}`): the page-side reader and where it runs (an isolated world when the driver allows, spec 02 §3.6). */

import type { Page } from 'playwright';
import { AppError } from '../../kernel/errors/app-error.ts';
import type { PageReadRequest, PageReadResult } from '../../ports/page-actions.ts';

/*
 * Core compiles without the DOM lib (it is a server package), so the page globals the reader touches
 * are declared here with the narrowest shape it uses. The reader is serialised (`String(readDom)`)
 * and runs in the page, so it may not reference anything outside its own body.
 */

/** The DOM node surface the reader walks. */
interface DomNode {
  readonly nodeType: number;
  readonly nodeValue: string | null;
  readonly childNodes: ArrayLike<DomNode>;
}

/** The DOM element surface the reader uses. */
interface DomElement extends DomNode {
  readonly localName: string;
  readonly outerHTML: string;
  readonly shadowRoot: DomNode | null;
  readonly ownerDocument: DomDocument;
  getAttribute(name: string): string | null;
  closest(selector: string): DomElement | null;
  assignedNodes?: (options: { flatten: boolean }) => DomNode[];
}

/** The document surface the reader uses. */
interface DomDocument {
  readonly documentElement: DomElement | null;
  readonly body: DomElement | null;
  querySelectorAll(selector: string): ArrayLike<DomElement>;
}

/** The computed style properties the reader reads. */
interface DomStyle {
  readonly display: string;
  readonly whiteSpace: string;
}

declare const document: DomDocument;
declare function getComputedStyle(element: DomElement): DomStyle;

/** What the page-side reader is asked for. JSON-plain: it crosses into the page. */
export interface ReadDomArg {
  readonly kind: 'text' | 'outer_html';
  /** `null`: the default root (text) or the whole document. */
  readonly selector: string | null;
  /** How many elements the driver's selector engine matched (`null` without a selector). */
  readonly expected: number | null;
}

/** What the page-side reader answers. `fallback`: the isolated world cannot resolve the selector the way the driver does. */
export type ReadDomOutcome =
  | { readonly status: 'ok'; readonly value: string }
  | { readonly status: 'fallback' };

/**
 * The page-side reader. `root` is the element the driver resolved (`null` when the reader runs in a
 * CDP isolated world and resolves `arg.selector` itself with `querySelectorAll`; any difference from
 * the driver's own count answers `fallback`).
 *
 * Text rules (spec 02 §3.6): a walk over the flat tree (open shadow roots and slots), not
 * `innerText`. `pre`-like white space is kept; other white space collapses to one space. Block boxes
 * produce line breaks (two around paragraphs, headings, lists, tables, `pre` and quotes), table
 * cells are separated by a tab, `<br>` is a line break. Skipped: `script`, `style`, `noscript`,
 * `template`, `svg`, iframes, form controls, and any `display: none` or `hidden` subtree, except a
 * `role=tabpanel` (inactive tab panels are read). Collapsed `<details>` content is read: it has no
 * box, but it is not `display: none`. Without a selector the root is the first visible `<main>` (or
 * `[role=main]`), else the page's only `<article>`, else `<body>` without its navigation chrome.
 */
export function readDom(root: DomElement | null, arg: ReadDomArg): ReadDomOutcome {
  const doc = root === null ? document : root.ownerDocument;
  const ELEMENT = 1;
  const TEXT = 3;
  const MAX_DEPTH = 1024;
  const SKIP = new Set([
    'script',
    'style',
    'noscript',
    'template',
    'svg',
    'head',
    'title',
    'meta',
    'link',
    'base',
    'iframe',
    'frame',
    'frameset',
    'object',
    'embed',
    'canvas',
    'input',
    'textarea',
    'select',
    'datalist',
    'video',
    'audio',
  ]);
  const DOUBLE = new Set([
    'p',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'pre',
    'blockquote',
    'ul',
    'ol',
    'dl',
    'table',
    'figure',
    'hr',
  ]);
  const CHROME_ROLES = new Set(['navigation', 'complementary', 'banner', 'contentinfo']);

  // The `hidden` attribute is `display: none` through the UA style sheet (author CSS can override
  // it, and `hidden="until-found"` is searchable collapsed content), so the computed value decides.
  const hidden = (el: DomElement): boolean => getComputedStyle(el).display === 'none';

  let target = root;
  if (arg.selector !== null && target === null) {
    let found: ArrayLike<DomElement>;
    try {
      found = doc.querySelectorAll(arg.selector);
    } catch {
      return { status: 'fallback' };
    }
    if (found.length === 0 || (arg.expected !== null && found.length !== arg.expected)) {
      return { status: 'fallback' };
    }
    target = found[0] ?? null;
    if (target === null) return { status: 'fallback' };
  }

  if (arg.kind === 'outer_html') {
    return { status: 'ok', value: (target ?? doc.documentElement)?.outerHTML ?? '' };
  }

  let stripChrome = false;
  if (arg.selector === null) {
    target = null;
    const mains = doc.querySelectorAll('main, [role="main"]');
    for (let i = 0; i < mains.length && target === null; i += 1) {
      const candidate = mains[i];
      if (candidate !== undefined && !hidden(candidate)) target = candidate;
    }
    if (target === null) {
      const articles = doc.querySelectorAll('article');
      if (articles.length === 1) target = articles[0] ?? null;
    }
    if (target === null) {
      target = doc.body ?? doc.documentElement;
      stripChrome = true;
    }
  }
  if (target === null) return { status: 'ok', value: '' };

  const isChrome = (el: DomElement): boolean => {
    const name = el.localName;
    if (name === 'nav' || name === 'aside') return true;
    const role = el.getAttribute('role');
    if (role !== null && CHROME_ROLES.has(role)) return true;
    if (name === 'header' || name === 'footer') {
      return el.closest('article, aside, main, nav, section') === null;
    }
    return false;
  };

  const out: string[] = [];
  let started = false;
  let trailingNewlines = 0;
  let pendingBreaks = 0;
  let pendingSeparator = '';

  const push = (s: string): void => {
    out.push(s);
    started = true;
    const lastBreak = s.lastIndexOf('\n');
    if (lastBreak === -1) {
      trailingNewlines = 0;
    } else if (lastBreak === s.length - 1) {
      let n = 0;
      for (let i = s.length - 1; i >= 0 && s[i] === '\n'; i -= 1) n += 1;
      trailingNewlines = n === s.length ? trailingNewlines + n : n;
    } else {
      trailingNewlines = 0;
    }
  };
  const flush = (): void => {
    if (!started) {
      pendingBreaks = 0;
      pendingSeparator = '';
      return;
    }
    if (pendingBreaks > trailingNewlines) push('\n'.repeat(pendingBreaks - trailingNewlines));
    else if (pendingBreaks === 0 && pendingSeparator !== '' && trailingNewlines === 0) {
      push(pendingSeparator);
    }
    pendingBreaks = 0;
    pendingSeparator = '';
  };
  const requireBreaks = (n: number): void => {
    if (n > pendingBreaks) pendingBreaks = n;
  };
  const separate = (s: string): void => {
    if (s === '\t' || pendingSeparator === '') pendingSeparator = s;
  };
  const text = (raw: string, preserve: boolean): void => {
    if (preserve) {
      const value = raw.replace(/\r\n?/g, '\n');
      if (value === '') return;
      flush();
      push(value);
      return;
    }
    const collapsed = raw.replace(/[ \t\n\r\f]+/g, ' ');
    if (collapsed === '') return;
    const leading = collapsed.startsWith(' ');
    const trailing = collapsed.endsWith(' ');
    const body = collapsed.trim();
    if (leading) separate(' ');
    if (body === '') return;
    flush();
    push(body);
    if (trailing) separate(' ');
  };
  const childrenOf = (node: DomNode): ArrayLike<DomNode> => {
    if (node.nodeType !== ELEMENT) return node.childNodes;
    const el = node as DomElement;
    if (el.shadowRoot !== null && el.shadowRoot !== undefined) return el.shadowRoot.childNodes;
    if (el.localName === 'slot' && typeof el.assignedNodes === 'function') {
      const assigned = el.assignedNodes({ flatten: false });
      if (assigned.length > 0) return assigned;
    }
    return el.childNodes;
  };
  const walk = (node: DomNode, preserve: boolean, depth: number, isRoot: boolean): void => {
    if (node.nodeType === TEXT) {
      text(node.nodeValue ?? '', preserve);
      return;
    }
    if (node.nodeType !== ELEMENT && node.nodeType !== 11) return;
    if (depth > MAX_DEPTH) return;
    if (node.nodeType === 11) {
      const kids = node.childNodes;
      for (let i = 0; i < kids.length; i += 1) {
        const kid = kids[i];
        if (kid !== undefined) walk(kid, preserve, depth + 1, false);
      }
      return;
    }
    const el = node as DomElement;
    const name = el.localName;
    if (SKIP.has(name)) return;
    if (name === 'br') {
      flush();
      push('\n');
      return;
    }
    const style = getComputedStyle(el);
    if (!isRoot) {
      if (style.display === 'none' && el.getAttribute('role') !== 'tabpanel') return;
      if (stripChrome && isChrome(el)) return;
    }
    const display = style.display;
    const ws = style.whiteSpace;
    const keep = ws.startsWith('pre') || ws === 'break-spaces';
    // A hidden tab panel computes `display: none`; it is read as a block.
    const inline =
      display.startsWith('inline') || display === 'contents' || display.startsWith('ruby');
    const cell = display === 'table-cell';
    const breaks = DOUBLE.has(name) ? 2 : 1;
    if (!inline && !cell) requireBreaks(breaks);
    const kids = childrenOf(el);
    for (let i = 0; i < kids.length; i += 1) {
      const kid = kids[i];
      if (kid !== undefined) walk(kid, keep, depth + 1, false);
    }
    if (cell) separate('\t');
    else if (!inline) requireBreaks(breaks);
  };
  walk(target, false, 0, true);
  return { status: 'ok', value: out.join('').replace(/^\n+/, '').trimEnd() };
}

/** Name of the isolated world BrowserHive's reads run in (stock Playwright, via CDP). */
export const READ_WORLD_NAME = '__browserhive_read__';

/** Navigation-race budget: how long a read waits for the next document before its one retry. */
const NAVIGATION_RETRY_MS = 5_000;

/** CDP answers that mean the read's execution context went away (a navigation committed). */
const CONTEXT_GONE_RE =
  /Cannot find context with specified id|Execution context was destroyed|Inspected target navigated or closed|Cannot find default execution context/;

/** The Chromium CDP surface the isolated read needs (`CDPSession.send` narrowed to three calls). */
interface ReadCdp {
  send(method: 'Page.getFrameTree'): Promise<{ frameTree: { frame: { id: string } } }>;
  send(
    method: 'Page.createIsolatedWorld',
    params: { frameId: string; worldName: string; grantUniveralAccess: boolean },
  ): Promise<{ executionContextId: number }>;
  send(
    method: 'Runtime.evaluate',
    params: {
      expression: string;
      contextId: number;
      returnByValue: boolean;
      timeout: number;
    },
  ): Promise<{
    result: { value?: unknown };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  }>;
  detach(): Promise<void>;
}

/** Narrows a `CDPSession` to {@link ReadCdp}. Safe: the three methods exist on every Chromium session. */
async function openCdp(page: Page): Promise<ReadCdp> {
  const session: unknown = await page.context().newCDPSession(page);
  return session as ReadCdp;
}

/** Parses the reader's answer (it crossed a serialisation boundary). */
function outcomeOf(value: unknown): ReadDomOutcome {
  if (typeof value === 'object' && value !== null) {
    const status = Object.getOwnPropertyDescriptor(value, 'status')?.value;
    const text = Object.getOwnPropertyDescriptor(value, 'value')?.value;
    if (status === 'ok' && typeof text === 'string') return { status: 'ok', value: text };
    if (status === 'fallback') return { status: 'fallback' };
  }
  throw new Error('page read returned an unexpected value');
}

/**
 * Runs the reader in a CDP isolated world of the main frame (stock Playwright on Chromium). Page
 * scripts can neither observe it nor change the DOM prototypes it uses. The world is created by
 * name, so Chromium reuses it within a document.
 */
async function readInIsolatedWorld(
  page: Page,
  arg: ReadDomArg,
  timeoutMs: number,
): Promise<ReadDomOutcome> {
  const cdp = await openCdp(page);
  try {
    const { frameTree } = await cdp.send('Page.getFrameTree');
    const { executionContextId } = await cdp.send('Page.createIsolatedWorld', {
      frameId: frameTree.frame.id,
      worldName: READ_WORLD_NAME,
      grantUniveralAccess: false,
    });
    const answer = await cdp.send('Runtime.evaluate', {
      expression: `(${String(readDom)})(null, ${JSON.stringify(arg)})`,
      contextId: executionContextId,
      returnByValue: true,
      timeout: timeoutMs,
    });
    if (answer.exceptionDetails !== undefined) {
      const description =
        answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text ?? '';
      if (/Execution was terminated/.test(description)) {
        throw new AppError(
          'WAIT_TIMEOUT',
          { what: 'the page read', timeout_ms: timeoutMs },
          { publicMessage: `Timed out after ${timeoutMs} ms waiting for the page read.` },
        );
      }
      throw new Error(`page read failed: ${description.split('\n')[0] ?? ''}`);
    }
    return outcomeOf(answer.result.value);
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

/** True when `err` says the read's execution context went away mid-call. */
function contextGone(err: unknown): boolean {
  return err instanceof Error && CONTEXT_GONE_RE.test(err.message);
}

/**
 * One BrowserHive-owned read (spec 02 §3.6). The selector is resolved by the driver first (its
 * count runs in Playwright's utility world); no match answers `{ found: false }`.
 *
 * - **Patchright** (`isolatedEvaluate`): `locator.evaluate` runs in Patchright's isolated world by
 *   default, with the driver's own element.
 * - **Stock Playwright**: a CDP isolated world. The reader resolves the selector with
 *   `querySelectorAll`; when that is not what the driver matched (Playwright-only selector syntax
 *   such as `text=` or `>>`, or matches inside shadow roots), the read falls back to
 *   `locator.evaluate` in the main world, and the result says so (`world: 'main'`).
 *
 * A navigation that destroys the context mid-read is retried once after `domcontentloaded`; a second
 * loss is `WAIT_TIMEOUT` ("the page to finish navigating"), as `get_content` answers (#55).
 */
export async function readPage(
  page: Page,
  isolatedEvaluate: boolean,
  request: PageReadRequest,
): Promise<PageReadResult> {
  const selector = request.selector;
  const timeout = request.timeoutMs;
  const count = selector === undefined ? null : await page.locator(selector).count();
  if (count === 0) return { found: false };
  const arg: ReadDomArg = { kind: request.kind, selector: selector ?? null, expected: count };

  const attempt = async (): Promise<PageReadResult> => {
    if (isolatedEvaluate) {
      const locator =
        selector === undefined ? page.locator(':root') : page.locator(selector).first();
      const outcome = outcomeOf(await locator.evaluate(readDom, arg, { timeout }));
      if (outcome.status === 'ok') return { found: true, value: outcome.value, world: 'isolated' };
      throw new Error('page read could not resolve its root');
    }
    const isolated = await readInIsolatedWorld(page, arg, timeout);
    if (isolated.status === 'ok') return { found: true, value: isolated.value, world: 'isolated' };
    if (selector === undefined) throw new Error('page read could not resolve its root');
    const outcome = outcomeOf(
      await page.locator(selector).first().evaluate(readDom, arg, { timeout }),
    );
    if (outcome.status === 'ok') return { found: true, value: outcome.value, world: 'main' };
    throw new Error('page read could not resolve its root');
  };

  try {
    return await attempt();
  } catch (err) {
    if (!contextGone(err)) throw err;
    const budget = timeout === 0 ? NAVIGATION_RETRY_MS : Math.min(timeout, NAVIGATION_RETRY_MS);
    await page.waitForLoadState('domcontentloaded', { timeout: budget }).catch(() => undefined);
    try {
      return await attempt();
    } catch (again) {
      if (!contextGone(again)) throw again;
      throw new AppError(
        'WAIT_TIMEOUT',
        { what: 'the page to finish navigating', timeout_ms: budget },
        {
          publicMessage: `Timed out after ${budget} ms waiting for the page to finish navigating.`,
          cause: again,
        },
      );
    }
  }
}

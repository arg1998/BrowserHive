/** @module infra/browsers/clipboard-frames — runs a script in the main world of every document already open in a browser context (spec 13 §2.1, D18 "applies live"): each page's main frame, every frame in its process (same-origin, `about:blank`, `srcdoc`, sandboxed and same-site cross-origin frames, nested ones too) and every out-of-process frame (cross-site, out-of-process sandboxed, and those nested in them) through DevTools links from the page's own session (`frame-links.ts`), never with a user gesture; and again in a page whose document comes back from the back/forward cache. */

import type { BrowserContext, CDPSession, Page } from 'patchright';
import { raceSignal, withDeadline } from '../../kernel/deadline.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Logger } from '../../ports/logger.ts';
import { childFrames, type FrameTarget, rootTarget } from './frame-links.ts';

/**
 * One page (its own frames and out-of-process ones) gets this long: a document stuck in a dialog
 * or a hung renderer does not hold the operator's `PATCH`. What it misses is counted.
 */
export const PATCH_PAGE_MS = 3_000;

/** What a run reached. */
export interface FramePatchCount {
  /** Documents the script ran in. */
  readonly patched: number;
  /** Documents (or whole pages) it could not reach: closing, hung, or the script threw. */
  readonly missed: number;
}

interface FrameTree {
  readonly frame: { readonly id: string };
  readonly childFrames?: readonly FrameTree[];
}

/** Every frame id below the root of a target's tree (the root is the target's own document). */
function childFrameIds(tree: FrameTree): string[] {
  const ids: string[] = [];
  const walk = (node: FrameTree): void => {
    for (const child of node.childFrames ?? []) {
      ids.push(child.frame.id);
      walk(child);
    }
  };
  walk(tree);
  return ids;
}

/**
 * Runs `source` (a function's source, called without arguments) in the main world of every
 * document of one DevTools target. The target's own document through `Runtime.evaluate`, which
 * runs in its main world; each other frame of its process through its document node resolved in
 * its main world (`DOM.resolveNode` without a context, as Patchright reaches an iframe's main
 * world). A frame without a `contentDocument` here runs in another process: its own target covers
 * it. `userGesture: false` everywhere: patching never gives a page user activation.
 */
async function patchTarget(cdp: FrameTarget, source: string): Promise<FramePatchCount> {
  let patched = 0;
  let missed = 0;
  const own = await cdp.send('Runtime.evaluate', {
    expression: `(${source})()`,
    userGesture: false,
    silent: true,
  });
  if (own.exceptionDetails === undefined) patched++;
  else missed++;
  const { frameTree } = await cdp.send('Page.getFrameTree');
  for (const frameId of childFrameIds(frameTree)) {
    try {
      const owner = await cdp.send('DOM.getFrameOwner', { frameId });
      const { node } = await cdp.send('DOM.describeNode', { backendNodeId: owner.backendNodeId });
      const document = node.contentDocument?.backendNodeId;
      if (document === undefined) continue;
      const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: document });
      if (object.objectId === undefined) {
        missed++;
        continue;
      }
      const ran = await cdp.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: `function () { (${source})(); }`,
        userGesture: false,
        silent: true,
      });
      if (ran.exceptionDetails === undefined) patched++;
      else missed++;
    } catch {
      // A frame that went away meanwhile; its next document gets the init script.
      missed++;
    }
  }
  return { patched, missed };
}

/** Nesting of out-of-process frames followed below a page (deeper ones are counted as missed). */
const MAX_DEPTH = 8;

/**
 * Patches `target` and every out-of-process frame below it: each target's own documents, then the
 * frames it attaches to (cross-site and out-of-process sandboxed frames), depth first.
 */
async function patchTree(
  target: FrameTarget,
  source: string,
  depth: number,
): Promise<FramePatchCount> {
  const own = await patchTarget(target, source);
  let { patched, missed } = own;
  const children = await childFrames(target).catch(() => []);
  for (const child of children) {
    if (depth >= MAX_DEPTH) {
      missed++;
      continue;
    }
    const count = await patchTree(child, source, depth + 1).catch(() => ({
      patched: 0,
      missed: 1,
    }));
    patched += count.patched;
    missed += count.missed;
  }
  return { patched, missed };
}

/**
 * One page: its own session, the frames in its process, and its out-of-process frames reached
 * through that session ({@link childFrames}), not through Patchright's frame list, which misses
 * some (frames nested in an out-of-process sandboxed frame; a page restored from the
 * back/forward cache). Detaching the page's session detaches everything below it.
 */
async function patchPage(
  context: BrowserContext,
  page: Page,
  source: string,
): Promise<FramePatchCount> {
  const cdp = await context.newCDPSession(page);
  try {
    return await patchTree(rootTarget(cdp), source, 0);
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

/** {@link patchPage} bounded by {@link PATCH_PAGE_MS}. */
function patchPageBounded(
  context: BrowserContext,
  page: Page,
  source: string,
): Promise<FramePatchCount> {
  using deadline = withDeadline(undefined, PATCH_PAGE_MS);
  return raceSignal(
    patchPage(context, page, source),
    deadline.signal,
    'clipboard patch',
    PATCH_PAGE_MS,
  );
}

/**
 * Runs `source` in every open document of `context`, pages in parallel, each bounded by
 * {@link PATCH_PAGE_MS}. Never throws: what it could not reach is counted in `missed`.
 */
export async function patchOpenDocuments(
  context: BrowserContext,
  source: string,
  log: Logger,
): Promise<FramePatchCount> {
  const pages = context.pages().filter((page) => !page.isClosed());
  const results = await Promise.allSettled(
    pages.map((page) => patchPageBounded(context, page, source)),
  );
  let patched = 0;
  let missed = 0;
  for (const result of results) {
    if (result.status === 'fulfilled') {
      patched += result.value.patched;
      missed += result.value.missed;
    } else {
      missed++;
      log.debug('clipboard patch missed', { err: serializeError(result.reason) });
    }
  }
  return { patched, missed };
}

/**
 * Pages open at a live change keep documents from before it in the back/forward cache, which no
 * patch run reached (verify #84 N3): going Back restores one as it was. Each watched page has its
 * own DevTools session with the `Page` domain on, and a main-frame `Page.frameNavigated` of type
 * `BackForwardCacheRestore` runs `source` in every document of the page again. Restored documents
 * keep whatever they took before (as any document open at the change). Pages opened afterwards
 * need none: their documents all got the init script.
 */
export class RestoredDocumentsWatch {
  readonly #context: BrowserContext;
  readonly #source: string;
  readonly #log: Logger;
  readonly #sessions = new Map<Page, CDPSession>();
  #stopped = false;

  constructor(context: BrowserContext, source: string, log: Logger) {
    this.#context = context;
    this.#source = source;
    this.#log = log;
  }

  /** Watches every open page; a page that cannot be watched is logged and skipped. */
  async watchOpenPages(): Promise<void> {
    const pages = this.#context.pages().filter((page) => !page.isClosed());
    await Promise.allSettled(pages.map((page) => this.#watch(page)));
  }

  async #watch(page: Page): Promise<void> {
    if (this.#sessions.has(page)) return;
    try {
      const cdp = await this.#context.newCDPSession(page);
      if (this.#stopped) {
        await cdp.detach().catch(() => undefined);
        return;
      }
      this.#sessions.set(page, cdp);
      page.once('close', () => this.#sessions.delete(page));
      cdp.on('Page.frameNavigated', ({ frame, type }) => {
        if (type !== 'BackForwardCacheRestore' || frame.parentId !== undefined) return;
        void patchPageBounded(this.#context, page, this.#source).then(
          (count) => {
            if (count.missed > 0) this.#log.warn('clipboard restore partial', { ...count });
            else this.#log.debug('clipboard restore patched', { ...count });
          },
          (err: unknown) =>
            this.#log.debug('clipboard restore missed', { err: serializeError(err) }),
        );
      });
      await cdp.send('Page.enable');
    } catch (err) {
      this.#log.debug('clipboard watch missed', { err: serializeError(err) });
    }
  }

  /** Detaches every watch session. */
  async stop(): Promise<void> {
    this.#stopped = true;
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.allSettled(sessions.map((cdp) => cdp.detach()));
  }
}

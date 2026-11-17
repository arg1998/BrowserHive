/** @module infra/browsers/clipboard-frames — runs a script in the main world of every document already open in a browser context (spec 13 §2.1, D18 "applies live"): each page's main frame, every frame in its process (same-origin, `about:blank`, `srcdoc`, sandboxed and same-site cross-origin frames, nested ones too) and every out-of-process (cross-site) frame through its own DevTools session, never with a user gesture. */

import type { BrowserContext, CDPSession, Frame, Page } from 'patchright';
import { raceSignal, withDeadline } from '../../kernel/deadline.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Logger } from '../../ports/logger.ts';

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
async function patchTarget(cdp: CDPSession, source: string): Promise<FramePatchCount> {
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

/** The page and its out-of-process frames: only those have a DevTools session of their own. */
async function sessionsOf(context: BrowserContext, page: Page): Promise<CDPSession[]> {
  const sessions = [await context.newCDPSession(page)];
  const children: Frame[] = page.frames().filter((frame) => frame !== page.mainFrame());
  for (const frame of children) {
    // Throws for a frame in its parent's process ("part of the parent frame's session").
    const own = await context.newCDPSession(frame).catch(() => null);
    if (own !== null) sessions.push(own);
  }
  return sessions;
}

async function patchPage(
  context: BrowserContext,
  page: Page,
  source: string,
): Promise<FramePatchCount> {
  const sessions = await sessionsOf(context, page);
  let patched = 0;
  let missed = 0;
  try {
    for (const cdp of sessions) {
      const count = await patchTarget(cdp, source);
      patched += count.patched;
      missed += count.missed;
    }
  } finally {
    await Promise.allSettled(sessions.map((cdp) => cdp.detach()));
  }
  return { patched, missed };
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
    pages.map(async (page) => {
      using deadline = withDeadline(undefined, PATCH_PAGE_MS);
      return raceSignal(
        patchPage(context, page, source),
        deadline.signal,
        'clipboard patch',
        PATCH_PAGE_MS,
      );
    }),
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

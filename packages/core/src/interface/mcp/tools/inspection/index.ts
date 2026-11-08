/** @module interface/mcp/tools/inspection — screenshot, snapshot, get_content, get_text, evaluate. */

import { dirname, join } from 'node:path';
import type { Page } from 'playwright';
import { sessionDirLayout } from '../../../../app/sessions/profile-dir.ts';
import type { Session } from '../../../../domain/session/session.ts';
import { AppError, isAppError } from '../../../../kernel/errors/app-error.ts';
import { serializeError } from '../../../../kernel/errors/serialize-error.ts';
import type { PageReadRequest } from '../../../../ports/page-actions.ts';
import { requireSession, type ToolCallContext } from '../../context.ts';
import {
  type ContentBlock,
  defineTool,
  json,
  type ScreenshotArtifact,
  type ToolPack,
} from '../../definition.ts';
import { evaluateAllowed, sandboxPath, sessionOwnership } from '../../policies.ts';
import { resolveScreenshotSavePath } from '../../sandbox.ts';
import { isolatedEvaluate } from '../interaction/act.ts';
import { drive, firstLine, pageOf, registryError, safeUrl } from '../shared.ts';
import { wrapFunctionExpression } from './evaluate-wrap.ts';
import { pageText, type TextPage } from './paging.ts';

/** Content type of every tool screenshot. */
export const SCREENSHOT_CONTENT_TYPE = 'image/png';

/**
 * Archives the exact bytes the agent receives under the call's event id so the dashboard shows
 * what the agent saw. Best-effort: a failure is a `SCREENSHOT_ARCHIVE_FAILED` warning, never a tool
 * failure.
 */
async function archive(
  ctx: ToolCallContext,
  sessionId: string,
  bytes: Uint8Array,
  meta: { width: number; height: number; url: string },
): Promise<ScreenshotArtifact | undefined> {
  const dir = sessionDirLayout(ctx.services.runtime.dataDir).forSession(sessionId).screenshots;
  const path = join(dir, `${ctx.eventId}.png`);
  try {
    await ctx.services.fs.mkdir(dir);
    await ctx.services.fs.writeFile(path, bytes);
    return { path, contentType: SCREENSHOT_CONTENT_TYPE, sizeBytes: bytes.byteLength, ...meta };
  } catch (err) {
    const session = ctx.services.sessions.peek(sessionId);
    if (session !== undefined) {
      ctx.services.sessions.warn(session, {
        code: 'SCREENSHOT_ARCHIVE_FAILED',
        sessionId,
        message: 'failed to archive the tool screenshot',
        details: { error: serializeError(err) },
      });
    }
    return undefined;
  }
}

/** `screenshot`: an image content block (+ `{ saved_to }` text when `save_path`), archived by event id. */
export const screenshot = defineTool('screenshot', {
  policies: [sessionOwnership, sandboxPath('save_path', 'screenshot')],
  telemetry: { captureResult: 'full' },
  async handler(ctx, args) {
    const session = requireSession(ctx);
    const page = pageOf(ctx, session, args.tab_id);
    const dataDir = ctx.services.runtime.dataDir;
    let savedTo: string | undefined;
    if (args.save_path !== undefined) {
      savedTo = await resolveScreenshotSavePath(dataDir, session.id, args.save_path);
      await ctx.services.fs.mkdir(dirname(savedTo));
    }
    const path = savedTo;
    const buffer = await drive(ctx, { sessionId: session.id, what: 'screenshot' }, () =>
      page.screenshot({
        fullPage: args.full_page,
        ...(args.clip !== undefined && { clip: args.clip }),
        omitBackground: args.omit_background,
        ...(path !== undefined && { path }),
      }),
    );
    const bytes = new Uint8Array(buffer);
    const viewport = page.viewportSize() ?? { width: 0, height: 0 };
    const artifact = await archive(ctx, session.id, bytes, {
      width: viewport.width,
      height: viewport.height,
      url: safeUrl(page),
    });
    const content: ContentBlock[] = [
      {
        type: 'image',
        data: Buffer.from(bytes).toString('base64'),
        mimeType: SCREENSHOT_CONTENT_TYPE,
      },
    ];
    if (savedTo !== undefined)
      content.push({ type: 'text', text: JSON.stringify({ saved_to: savedTo }) });
    return {
      kind: 'content',
      content,
      structured: {
        ...(savedTo !== undefined && { saved_to: savedTo }),
        width: viewport.width,
        height: viewport.height,
        bytes: bytes.byteLength,
      },
      ...(artifact !== undefined && {
        facts: { screenshot: { ...artifact, sessionId: session.id } },
      }),
    };
  },
});

/** Budget of one reading call's driver work, in ms (the tool `Timeout` default). */
const READ_TIMEOUT_MS = 30_000;

/** Playwright's selector parser errors (`Unexpected token … while parsing css selector …`, `Unknown engine …`). */
const SELECTOR_SYNTAX_RE = /while parsing (?:css )?selector/;

/** `ELEMENT_NOT_FOUND` for a reading tool's `selector` that matched nothing. */
function notFound(selector: string): AppError<'ELEMENT_NOT_FOUND'> {
  return registryError('ELEMENT_NOT_FOUND', { selector, count: 0 });
}

/**
 * Runs a reading tool's driver work: a selector the driver cannot parse is `INVALID_ARGUMENTS` on
 * `selector` (not `INTERNAL_ERROR`); everything else goes through the classifier.
 */
function reading<T>(
  ctx: ToolCallContext,
  session: Session,
  selector: string | undefined,
  what: string,
  run: () => Promise<T>,
): Promise<T> {
  return drive(
    ctx,
    { sessionId: session.id, what, ...(selector !== undefined && { selector }) },
    async () => {
      try {
        return await run();
      } catch (err) {
        if (isAppError(err) || selector === undefined) throw err;
        if (!(err instanceof Error) || !SELECTOR_SYNTAX_RE.test(err.message)) throw err;
        const message = firstLine(err).replace(/^[\w.]+:\s*/, '');
        throw new AppError(
          'INVALID_ARGUMENTS',
          { issues: [{ path: 'selector', message }] },
          { publicMessage: `selector: ${message}`, cause: err },
        );
      }
    },
  );
}

/**
 * One of BrowserHive's own DOM reads (`get_text`, `get_content {selector}`), through the page-actions
 * seam so it runs in an isolated world where the driver allows it. Not agent code: the evaluate
 * gate does not apply.
 */
async function ownRead(
  ctx: ToolCallContext,
  session: Session,
  page: Page,
  kind: PageReadRequest['kind'],
  selector: string | undefined,
): Promise<string> {
  const request: PageReadRequest = {
    kind,
    timeoutMs: READ_TIMEOUT_MS,
    ...(selector !== undefined && { selector }),
  };
  const result = await reading(
    ctx,
    session,
    selector,
    kind === 'text' ? 'page text' : 'element html',
    () => ctx.services.pageActions.readPage(page, isolatedEvaluate(session), request),
  );
  if (!result.found) throw notFound(selector ?? '');
  return result.value;
}

/**
 * Redacts the whole text first, then cuts the page: a credential that straddles a page boundary is
 * still scrubbed, and the offsets index the text the agent actually receives.
 */
function paged(
  ctx: ToolCallContext,
  session: Session,
  text: string,
  args: { readonly offset: number; readonly max_chars: number },
): TextPage {
  return pageText(ctx.services.redaction.scrubText(session.id, text), args.offset, args.max_chars);
}

/** `snapshot`: ARIA accessibility tree (YAML) of the body or of the first `selector` match, paged. */
export const snapshot = defineTool('snapshot', {
  policies: [sessionOwnership],
  async handler(ctx, args) {
    const session = requireSession(ctx);
    const page = pageOf(ctx, session, args.tab_id);
    const selector = args.selector;
    const full = await reading(ctx, session, selector, 'aria snapshot', async () => {
      if (selector === undefined) return page.locator('body').ariaSnapshot();
      const matches = page.locator(selector);
      if ((await matches.count()) === 0) throw notFound(selector);
      return matches.first().ariaSnapshot({ timeout: READ_TIMEOUT_MS });
    });
    const { chunk, ...paging } = paged(ctx, session, full, args);
    return json({ session_id: session.id, url: safeUrl(page), tree: chunk, ...paging });
  },
});

/** `get_content`: `page.content()`, or the `outerHTML` of the first `selector` match, paged. */
export const getContent = defineTool('get_content', {
  policies: [sessionOwnership],
  async handler(ctx, args) {
    const session = requireSession(ctx);
    const page = pageOf(ctx, session, args.tab_id);
    const full =
      args.selector === undefined
        ? await drive(ctx, { sessionId: session.id, what: 'page content' }, () => page.content())
        : await ownRead(ctx, session, page, 'outer_html', args.selector);
    const { chunk, ...paging } = paged(ctx, session, full, args);
    return json({ session_id: session.id, url: safeUrl(page), html: chunk, ...paging });
  },
});

/** `get_text`: BrowserHive's readable-text walk of the default root or the first `selector` match, paged. */
export const getText = defineTool('get_text', {
  policies: [sessionOwnership],
  async handler(ctx, args) {
    const session = requireSession(ctx);
    const page = pageOf(ctx, session, args.tab_id);
    const full = await ownRead(ctx, session, page, 'text', args.selector);
    const { chunk, ...paging } = paged(ctx, session, full, args);
    return json({ session_id: session.id, url: safeUrl(page), text: chunk, ...paging });
  },
});

/**
 * `evaluate`: refused by `evaluateAllowed` (session `disable_evaluate` or server
 * `allowEvaluate=false`); runs in the main world on every driver.
 */
export const evaluate = defineTool('evaluate', {
  policies: [sessionOwnership, evaluateAllowed],
  async handler(ctx, args) {
    const session = requireSession(ctx);
    const page = pageOf(ctx, session, args.tab_id);
    const expression = wrapFunctionExpression(args.expression);
    const result = await drive(ctx, { sessionId: session.id, what: 'evaluate' }, () =>
      ctx.services.pageActions.evaluate(page, isolatedEvaluate(session), expression),
    );
    if (result !== undefined) return json({ session_id: session.id, result });
    // A page-side `undefined` disappears from the JSON text (`JSON.stringify` drops it, and the text
    // format is part of the tool contract); structured content carries null.
    return {
      kind: 'content',
      content: [{ type: 'text', text: JSON.stringify({ session_id: session.id, result }) }],
      structured: { session_id: session.id, result: null },
    };
  },
});

/** The inspection pack. */
export const inspectionPack: ToolPack = {
  id: 'inspection',
  tools: [screenshot, snapshot, getContent, getText, evaluate],
};

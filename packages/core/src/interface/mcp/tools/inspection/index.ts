/** @module interface/mcp/tools/inspection — screenshot, snapshot, get_content, evaluate. */

import { dirname, join } from 'node:path';
import { sessionDirLayout } from '../../../../app/sessions/profile-dir.ts';
import { serializeError } from '../../../../kernel/errors/serialize-error.ts';
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
import { drive, pageOf, safeUrl } from '../shared.ts';
import { wrapFunctionExpression } from './evaluate-wrap.ts';

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

/** `snapshot`: ARIA accessibility tree (YAML). */
export const snapshot = defineTool('snapshot', {
  policies: [sessionOwnership],
  async handler(ctx, args) {
    const session = requireSession(ctx);
    const page = pageOf(ctx, session, args.tab_id);
    const tree = await drive(ctx, { sessionId: session.id, what: 'aria snapshot' }, () =>
      page.locator('body').ariaSnapshot(),
    );
    return json({ session_id: session.id, url: safeUrl(page), tree });
  },
});

/** `get_content`: `page.content()`. */
export const getContent = defineTool('get_content', {
  policies: [sessionOwnership],
  async handler(ctx, args) {
    const session = requireSession(ctx);
    const page = pageOf(ctx, session, args.tab_id);
    const html = await drive(ctx, { sessionId: session.id, what: 'page content' }, () =>
      page.content(),
    );
    return json({ session_id: session.id, url: safeUrl(page), html });
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
  tools: [screenshot, snapshot, getContent, evaluate],
};

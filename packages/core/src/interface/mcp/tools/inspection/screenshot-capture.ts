/** @module interface/mcp/tools/inspection/screenshot-capture — `screenshot`'s capture: Playwright, and in a template session a fallback straight from the window surface when Playwright stalls (spec 13 §3.3, §3.10: rendering of a minimized window can stall). */

import type { Session } from '../../../../domain/session/session.ts';
import type { Page } from '../../../../ports/page-types.ts';
import type { ToolCallContext } from '../../context.ts';
import { drive } from '../shared.ts';

/** How long Playwright may take for a template session's screenshot before the fallback (§3.3). */
export const TEMPLATE_SCREENSHOT_TIMEOUT_MS = 10_000;

/** What to capture (the tool's arguments). */
export interface CaptureRequest {
  readonly fullPage: boolean;
  readonly clip?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly omitBackground: boolean;
  /** Also written here (already sandboxed). */
  readonly path?: string;
}

function isTimeout(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'TimeoutError' || /Timeout \d+ms exceeded/.test(err.message))
  );
}

/**
 * A PNG of `page`. Exclusive sessions: Playwright as before. Template sessions: Playwright with a
 * 10 s timeout, then once more with `Page.captureScreenshot {fromSurface: true}` on the page's own
 * DevTools session.
 */
export async function captureScreenshot(
  ctx: ToolCallContext,
  session: Session,
  page: Page,
  request: CaptureRequest,
): Promise<Uint8Array> {
  const options = {
    fullPage: request.fullPage,
    ...(request.clip !== undefined && { clip: request.clip }),
    omitBackground: request.omitBackground,
    ...(request.path !== undefined && { path: request.path }),
  };
  const context = { sessionId: session.id, what: 'screenshot' };
  const view = session.view;
  if (session.template === null || view === null) {
    return new Uint8Array(await drive(ctx, context, () => page.screenshot(options)));
  }
  try {
    const shot = await page.screenshot({ ...options, timeout: TEMPLATE_SCREENSHOT_TIMEOUT_MS });
    return new Uint8Array(shot);
  } catch (err) {
    if (!isTimeout(err))
      return new Uint8Array(await drive(ctx, context, () => Promise.reject(err)));
    ctx.log.info('screenshot fallback', { sessionId: session.id });
  }
  const bytes = await drive(ctx, context, async () => {
    const cdp = await view.newCDPSession(page);
    try {
      const clip = request.clip ?? (request.fullPage ? await fullPageClip(cdp) : undefined);
      const shot = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        ...(clip !== undefined && { clip: { ...clip, scale: 1 }, captureBeyondViewport: true }),
      });
      return Uint8Array.from(Buffer.from(shot.data, 'base64'));
    } finally {
      await cdp.detach().catch(() => undefined);
    }
  });
  if (request.path !== undefined) await ctx.services.fs.writeFile(request.path, bytes);
  return bytes;
}

async function fullPageClip(cdp: {
  send(method: 'Page.getLayoutMetrics'): Promise<{
    cssContentSize: { width: number; height: number };
  }>;
}): Promise<{ x: number; y: number; width: number; height: number }> {
  const metrics = await cdp.send('Page.getLayoutMetrics');
  const { width, height } = metrics.cssContentSize;
  return { x: 0, y: 0, width: Math.ceil(width), height: Math.ceil(height) };
}

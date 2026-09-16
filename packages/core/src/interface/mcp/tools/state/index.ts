/** @module interface/mcp/tools/state — get_cookies, set_cookies, set_viewport, set_extra_http_headers. */

import type { BrowserContext } from 'playwright';
import type { Session } from '../../../../domain/session/session.ts';
import { AppError, isAppError } from '../../../../kernel/errors/app-error.ts';
import { requireSession } from '../../context.ts';
import { defineTool, json, type ToolPack } from '../../definition.ts';
import { sessionOwnership } from '../../policies.ts';
import { drive, firstLine, pageOf } from '../shared.ts';
import { clampToAssertedDisplay, splitIdentityHeaders } from './headers.ts';

/** Playwright's `addCookies` parameter, the landing type of the loose cookie schema. */
type PlaywrightCookies = Parameters<BrowserContext['addCookies']>[0];

function contextOf(session: Session): BrowserContext {
  const handle = session.handle;
  if (handle === null) {
    throw new AppError(
      'SESSION_NOT_LIVE',
      { session_id: session.id },
      { publicMessage: `Session '${session.id}' is not live.` },
    );
  }
  return handle.context;
}

/** `get_cookies`: full values go to the agent; the observation records shape only (D-20). */
export const getCookies = defineTool('get_cookies', {
  policies: [sessionOwnership],
  telemetry: { captureResult: 'size' },
  async handler(ctx, args) {
    const session = requireSession(ctx);
    const context = contextOf(session);
    const urls = args.urls;
    const cookies = await drive(ctx, { sessionId: session.id }, () =>
      urls !== undefined ? context.cookies(urls) : context.cookies(),
    );
    return json({ cookies: cookies.map((c) => ({ ...c })) });
  },
});

/** `set_cookies`: Playwright's cookie validation surfaces as `INVALID_ARGUMENTS` (was raw). */
export const setCookies = defineTool('set_cookies', {
  policies: [sessionOwnership],
  telemetry: { captureArgs: 'shape' },
  async handler(ctx, args) {
    const session = requireSession(ctx);
    const context = contextOf(session);
    try {
      // The loose cookie schema forwards Playwright's full cookie surface; Playwright validates it.
      await context.addCookies(args.cookies as unknown as PlaywrightCookies);
    } catch (err) {
      if (isAppError(err)) throw err;
      const classified = ctx.services.pageActions.classifyError(err, { sessionId: session.id });
      if (classified !== null && classified.code === 'BROWSER_CRASHED') throw classified;
      const message = firstLine(err).replace(/^browserContext\.addCookies:\s*/, '');
      throw new AppError(
        'INVALID_ARGUMENTS',
        { issues: [{ path: 'cookies', message }] },
        { publicMessage: `cookies: ${message}`, cause: err },
      );
    }
    return json({ added: args.cookies.length });
  },
});

/** `set_viewport`: clamped to the asserted display; invalidates the humanize cursor mirror. */
export const setViewport = defineTool('set_viewport', {
  policies: [sessionOwnership],
  async handler(ctx, args) {
    const session = requireSession(ctx);
    const page = pageOf(ctx, session, args.tab_id);
    const { width, height, clamped } = clampToAssertedDisplay(
      session.identity,
      args.width,
      args.height,
    );
    await drive(ctx, { sessionId: session.id }, () => page.setViewportSize({ width, height }));
    ctx.services.pageActions.invalidateCursor(session.id, page);
    return json({
      session_id: session.id,
      width,
      height,
      ...(clamped && { clamped: true as const }),
    });
  },
});

/**
 * `set_extra_http_headers`: replaces previous extras. Gated on `stealth` (the CDP override applies to
 * every stealth session; `fingerprint` is strictly narrower).
 */
export const setExtraHttpHeaders = defineTool('set_extra_http_headers', {
  policies: [sessionOwnership],
  async handler(ctx, args) {
    const session = requireSession(ctx);
    const context = contextOf(session);
    const identityOn = session.request.stealth || session.request.fingerprint;
    const { accepted, rejected } = splitIdentityHeaders(args.headers, identityOn);
    await drive(ctx, { sessionId: session.id }, () => context.setExtraHTTPHeaders(accepted));
    return json({ session_id: session.id, applied: Object.keys(accepted).length, rejected });
  },
});

/** The state pack. */
export const statePack: ToolPack = {
  id: 'state',
  tools: [getCookies, setCookies, setViewport, setExtraHttpHeaders],
};

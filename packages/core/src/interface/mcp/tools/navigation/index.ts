/** @module interface/mcp/tools/navigation — navigate, go_back, go_forward, reload, wait_for_url. */

import { requireSession } from '../../context.ts';
import { defineTool, json, type ToolPack } from '../../definition.ts';
import { sessionOwnership, urlBlocklist } from '../../policies.ts';
import { drive, navigation, pageOf, recordNavigation, safeUrl } from '../shared.ts';

/** `navigate`: blocklist before the browser is touched; HTTP 4xx/5xx is a soft failure (`HTTP_<n>`). */
export const navigate = defineTool('navigate', {
  policies: [sessionOwnership, urlBlocklist('url')],
  async handler(ctx, args) {
    const session = requireSession(ctx);
    const page = pageOf(ctx, session, args.tab_id);
    const target = { url: args.url, timeoutMs: args.timeout, tabId: args.tab_id };
    const response = await navigation(ctx, session, target, () =>
      page.goto(args.url, { waitUntil: args.wait_until, timeout: args.timeout }),
    );
    const visit = await recordNavigation(ctx, session, page);
    return json(
      { session_id: session.id, url: safeUrl(page), status: response?.status() ?? null },
      { pageVisit: visit },
    );
  },
});

/** `go_back`. */
export const goBack = defineTool('go_back', {
  policies: [sessionOwnership],
  async handler(ctx, args) {
    const session = requireSession(ctx);
    const page = pageOf(ctx, session, args.tab_id);
    const target = { url: safeUrl(page), timeoutMs: args.timeout, tabId: args.tab_id };
    await navigation(ctx, session, target, () =>
      page.goBack({ waitUntil: args.wait_until, timeout: args.timeout }),
    );
    const visit = await recordNavigation(ctx, session, page);
    return json({ session_id: session.id, url: safeUrl(page) }, { pageVisit: visit });
  },
});

/** `go_forward`. */
export const goForward = defineTool('go_forward', {
  policies: [sessionOwnership],
  async handler(ctx, args) {
    const session = requireSession(ctx);
    const page = pageOf(ctx, session, args.tab_id);
    const target = { url: safeUrl(page), timeoutMs: args.timeout, tabId: args.tab_id };
    await navigation(ctx, session, target, () =>
      page.goForward({ waitUntil: args.wait_until, timeout: args.timeout }),
    );
    const visit = await recordNavigation(ctx, session, page);
    return json({ session_id: session.id, url: safeUrl(page) }, { pageVisit: visit });
  },
});

/** `reload`. */
export const reload = defineTool('reload', {
  policies: [sessionOwnership],
  async handler(ctx, args) {
    const session = requireSession(ctx);
    const page = pageOf(ctx, session, args.tab_id);
    const target = { url: safeUrl(page), timeoutMs: args.timeout, tabId: args.tab_id };
    await navigation(ctx, session, target, () =>
      page.reload({ waitUntil: args.wait_until, timeout: args.timeout }),
    );
    const visit = await recordNavigation(ctx, session, page);
    return json({ session_id: session.id, url: safeUrl(page) }, { pageVisit: visit });
  },
});

/** `wait_for_url`: string (exact/glob) or `{ pattern, flags? }` compiled to a RegExp; no count bump. */
export const waitForUrl = defineTool('wait_for_url', {
  policies: [sessionOwnership],
  async handler(ctx, args) {
    const session = requireSession(ctx);
    const page = pageOf(ctx, session, args.tab_id);
    const matcher =
      typeof args.url === 'string' ? args.url : new RegExp(args.url.pattern, args.url.flags);
    const what = `url to match ${typeof args.url === 'string' ? args.url : `/${args.url.pattern}/`}`;
    await drive(ctx, { what, timeoutMs: args.timeout, sessionId: session.id }, () =>
      page.waitForURL(matcher, { timeout: args.timeout }),
    );
    return json({ session_id: session.id, url: safeUrl(page) });
  },
});

/** The navigation pack. */
export const navigationPack: ToolPack = {
  id: 'navigation',
  tools: [navigate, goBack, goForward, reload, waitForUrl],
};

/** @module interface/mcp/tools/tabs — new_tab, close_tab, switch_tab, list_tabs. */

import { requireSession } from '../../context.ts';
import { defineTool, json, type PageVisit, type ToolPack } from '../../definition.ts';
import { sessionOwnership, urlBlocklist } from '../../policies.ts';
import { navigation, recordNavigation, safeUrl } from '../shared.ts';

/** `new_tab`: opens a tab (identity override awaited first), makes it active, optionally navigates. */
export const newTab = defineTool('new_tab', {
  policies: [sessionOwnership, urlBlocklist('url')],
  async handler(ctx, args) {
    const session = requireSession(ctx);
    const { tabId, page } = await ctx.services.sessions.newTab(session);
    let visit: PageVisit | undefined;
    if (args.url !== undefined) {
      const url = args.url;
      await navigation(ctx, session, { url, timeoutMs: args.timeout, tabId }, () =>
        page.goto(url, { waitUntil: args.wait_until, timeout: args.timeout }),
      );
      visit = await recordNavigation(ctx, session, page);
    }
    return json(
      { session_id: session.id, tab_id: tabId, url: safeUrl(page) },
      visit === undefined ? undefined : { pageVisit: visit },
    );
  },
});

/** `close_tab`: closing the active tab promotes the most recently added survivor. */
export const closeTab = defineTool('close_tab', {
  policies: [sessionOwnership],
  async handler(ctx, args) {
    const session = requireSession(ctx);
    await ctx.services.sessions.closeTab(session, args.tab_id);
    return json({ session_id: session.id, tab_id: args.tab_id, closed: true as const });
  },
});

/** `switch_tab`. */
export const switchTab = defineTool('switch_tab', {
  policies: [sessionOwnership],
  async handler(ctx, args) {
    const session = requireSession(ctx);
    const page = ctx.services.sessions.switchTab(session, args.tab_id);
    return json({ session_id: session.id, tab_id: args.tab_id, url: safeUrl(page) });
  },
});

/** `list_tabs`: bare array in insertion order; `title` is `''` on failure. */
export const listTabs = defineTool('list_tabs', {
  policies: [sessionOwnership],
  async handler(ctx) {
    const session = requireSession(ctx);
    const tabs = await ctx.services.sessions.listTabs(session);
    return json(
      tabs.map((t) => ({ tab_id: t.tabId, url: t.url, title: t.title, active: t.active })),
    );
  },
});

/** The tabs pack. */
export const tabsPack: ToolPack = { id: 'tabs', tools: [newTab, closeTab, switchTab, listTabs] };

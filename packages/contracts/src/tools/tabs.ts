/** @module contracts/tools/tabs — new_tab, close_tab, switch_tab, list_tabs contracts */
import { z } from 'zod';
import { annotations, SESSION_ERRORS, SINCE, WaitUntil } from './shared.ts';
import { defineTool } from './types.ts';

/** One `list_tabs` row. `title` is `''` when the page refused to report one. */
export const TabSummary = z.object({
  tab_id: z.string(),
  url: z.string(),
  title: z.string(),
  active: z.boolean(),
});

/** `new_tab`: opens, registers and activates a tab; optionally navigates it. */
export const NEW_TAB = defineTool({
  name: 'new_tab',
  title: 'New tab',
  description:
    'Open a new tab in the session and make it active. Optionally navigate it to a URL. ' +
    'Returns the stable tab_id other tools accept via their optional tab_id argument.',
  input: z.object({
    session_id: z.string(),
    url: z.string().optional(),
    wait_until: WaitUntil.default('load'),
    timeout: z.number().int().nonnegative().default(30_000),
  }),
  output: z.object({ session_id: z.string(), tab_id: z.string(), url: z.string() }),
  annotations: annotations(false, false, false, true),
  pack: 'tabs',
  capability: 'navigate',
  errors: [...SESSION_ERRORS, 'URL_BLOCKED', 'NAVIGATION_TIMEOUT', 'NAVIGATION_FAILED'],
  since: SINCE,
});

/** `close_tab`: closing the active tab promotes the most recently added survivor. */
export const CLOSE_TAB = defineTool({
  name: 'close_tab',
  title: 'Close tab',
  description: 'Close a tab by id. If it was the active tab, another open tab becomes active.',
  input: z.object({ session_id: z.string(), tab_id: z.string() }),
  output: z.object({ session_id: z.string(), tab_id: z.string(), closed: z.literal(true) }),
  annotations: annotations(false, true, true, false),
  pack: 'tabs',
  capability: 'mutate',
  errors: [...SESSION_ERRORS, 'TAB_NOT_FOUND'],
  since: SINCE,
});

/** `switch_tab`: makes a tab the target of subsequent `tab_id`-less calls. */
export const SWITCH_TAB = defineTool({
  name: 'switch_tab',
  title: 'Switch tab',
  description: 'Make the given tab the active tab for subsequent tab_id-less tool calls.',
  input: z.object({ session_id: z.string(), tab_id: z.string() }),
  output: z.object({ session_id: z.string(), tab_id: z.string(), url: z.string() }),
  annotations: annotations(false, false, true, false),
  pack: 'tabs',
  capability: 'mutate',
  errors: [...SESSION_ERRORS, 'TAB_NOT_FOUND'],
  since: SINCE,
});

/** `list_tabs`: a **bare array** in insertion order (frozen shape, D-12). */
export const LIST_TABS = defineTool({
  name: 'list_tabs',
  title: 'List tabs',
  description: 'List every open tab: its tab_id, current URL, title, and whether it is active.',
  input: z.object({ session_id: z.string() }),
  output: z.array(TabSummary),
  annotations: annotations(true, false, true, false),
  pack: 'tabs',
  capability: 'read',
  errors: [...SESSION_ERRORS],
  since: SINCE,
});

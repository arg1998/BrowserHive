/** @module contracts/tools/navigation — navigate, go_back, go_forward, reload, wait_for_url contracts */
import { z } from 'zod';
import { annotations, SESSION_ERRORS, SINCE, TabId, Timeout, WaitUntil } from './shared.ts';
import { defineTool } from './types.ts';

/** `go_back` / `go_forward` / `reload` share one argument shape. */
export const HistoryNavInput = z.object({
  session_id: z.string(),
  wait_until: WaitUntil.default('load'),
  timeout: Timeout,
  tab_id: TabId,
});

/** `{ session_id, url }` — the post-navigation URL. */
export const UrlResult = z.object({ session_id: z.string(), url: z.string() });

const HISTORY_ERRORS = [
  ...SESSION_ERRORS,
  'TAB_NOT_FOUND',
  'NAVIGATION_TIMEOUT',
  'NAVIGATION_FAILED',
] as const;

/** `navigate`: `page.goto`; the blocklist is checked before the browser is touched. */
export const NAVIGATE = defineTool({
  name: 'navigate',
  title: 'Navigate',
  description:
    'Navigate a tab to a URL (defaults to the active tab). The operator may maintain a URL ' +
    'blocklist; a blocked target fails with URL_BLOCKED and must not be retried.',
  input: z.object({
    session_id: z.string(),
    url: z.string(),
    wait_until: WaitUntil.default('load'),
    timeout: Timeout,
    tab_id: TabId,
  }),
  output: z.object({ session_id: z.string(), url: z.string(), status: z.number().nullable() }),
  annotations: annotations(false, false, false, true),
  pack: 'navigation',
  capability: 'navigate',
  errors: [
    ...SESSION_ERRORS,
    'URL_BLOCKED',
    'TAB_NOT_FOUND',
    'NAVIGATION_TIMEOUT',
    'NAVIGATION_FAILED',
  ],
  since: SINCE,
});

/** `go_back`: `page.goBack`. */
export const GO_BACK = defineTool({
  name: 'go_back',
  title: 'Go back',
  description: "Navigate back in a tab's history (defaults to the active tab).",
  input: HistoryNavInput,
  output: UrlResult,
  annotations: annotations(false, false, false, true),
  pack: 'navigation',
  capability: 'navigate',
  errors: [...HISTORY_ERRORS],
  since: SINCE,
});

/** `go_forward`: `page.goForward`. */
export const GO_FORWARD = defineTool({
  name: 'go_forward',
  title: 'Go forward',
  description: "Navigate forward in a tab's history (defaults to the active tab).",
  input: HistoryNavInput,
  output: UrlResult,
  annotations: annotations(false, false, false, true),
  pack: 'navigation',
  capability: 'navigate',
  errors: [...HISTORY_ERRORS],
  since: SINCE,
});

/** `reload`: `page.reload`. */
export const RELOAD = defineTool({
  name: 'reload',
  title: 'Reload',
  description: 'Reload the current page in a tab (defaults to the active tab).',
  input: HistoryNavInput,
  output: UrlResult,
  annotations: annotations(false, false, true, true),
  pack: 'navigation',
  capability: 'navigate',
  errors: [...HISTORY_ERRORS],
  since: SINCE,
});

/**
 * `wait_for_url`: `url` is a string (exact/glob per Playwright) or a `{ pattern, flags? }` object
 * compiled to a `RegExp`. Property-level union only; the root stays an object.
 */
export const WAIT_FOR_URL = defineTool({
  name: 'wait_for_url',
  title: 'Wait for URL',
  description:
    "Wait until a tab's URL matches. `url` may be a string (exact/glob) or a " +
    '{ pattern, flags? } object compiled to a regular expression.',
  input: z.object({
    session_id: z.string(),
    url: z.union([
      z.string(),
      z.object({ pattern: z.string().min(1), flags: z.string().optional() }),
    ]),
    timeout: Timeout,
    tab_id: TabId,
  }),
  output: UrlResult,
  annotations: annotations(true, false, true, false),
  pack: 'navigation',
  capability: 'read',
  errors: [...SESSION_ERRORS, 'TAB_NOT_FOUND', 'WAIT_TIMEOUT'],
  since: SINCE,
});

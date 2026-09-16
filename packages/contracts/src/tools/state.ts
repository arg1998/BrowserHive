/** @module contracts/tools/state — get_cookies, set_cookies, set_viewport, set_extra_http_headers contracts */
import { z } from 'zod';
import { annotations, SESSION_ERRORS, SINCE, TabId } from './shared.ts';
import { defineTool } from './types.ts';

/**
 * A cookie accepted by `set_cookies`. `looseObject` so the full Playwright cookie surface
 * (`url` | `domain`+`path`, `sameSite`, `expires`, `httpOnly`, `secure`, …) passes through;
 * Playwright validates on `addCookies` (surfaced as `INVALID_ARGUMENTS`).
 */
export const CookieInput = z.looseObject({ name: z.string(), value: z.string() });

/** A cookie as returned by `get_cookies` (Playwright's `Cookie`; loose for forward-compat). */
export const Cookie = z.looseObject({
  name: z.string(),
  value: z.string(),
  domain: z.string(),
  path: z.string(),
  expires: z.number(),
  httpOnly: z.boolean(),
  secure: z.boolean(),
  sameSite: z.enum(['Strict', 'Lax', 'None']),
  partitionKey: z.string().optional(),
});

/** `get_cookies`: full values go to the agent, never to persistence (D-20). No `session_id` key. */
export const GET_COOKIES = defineTool({
  name: 'get_cookies',
  title: 'Get cookies',
  description:
    "Return the session context's cookies, optionally filtered to those that would be sent " +
    'to the given URLs.',
  input: z.object({ session_id: z.string(), urls: z.array(z.string()).optional() }),
  output: z.object({ cookies: z.array(Cookie) }),
  annotations: annotations(true, false, true, false),
  pack: 'state',
  capability: 'read',
  errors: [...SESSION_ERRORS],
  since: SINCE,
});

/** `set_cookies`: `context.addCookies`. No `session_id` key in the result. */
export const SET_COOKIES = defineTool({
  name: 'set_cookies',
  title: 'Set cookies',
  description:
    'Add cookies to the session context. Each cookie needs name+value and either a url or a ' +
    'domain+path (Playwright semantics).',
  input: z.object({
    session_id: z.string(),
    cookies: z.array(CookieInput).min(1, 'cookies must include at least one entry'),
  }),
  output: z.object({ added: z.number() }),
  annotations: annotations(false, false, true, false),
  pack: 'state',
  capability: 'mutate',
  errors: [...SESSION_ERRORS, 'INVALID_ARGUMENTS'],
  since: SINCE,
});

/** `set_viewport`: clamped to the asserted display under a fingerprint; `clamped` only when true. */
export const SET_VIEWPORT = defineTool({
  name: 'set_viewport',
  title: 'Set viewport',
  description: "Set a tab's viewport size in CSS pixels.",
  input: z.object({
    session_id: z.string(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    tab_id: TabId,
  }),
  output: z.object({
    session_id: z.string(),
    width: z.number(),
    height: z.number(),
    clamped: z.literal(true).optional(),
  }),
  annotations: annotations(false, false, true, false),
  pack: 'state',
  capability: 'mutate',
  errors: [...SESSION_ERRORS, 'TAB_NOT_FOUND'],
  since: SINCE,
});

/** `set_extra_http_headers`: replaces previous extras; identity-owned headers are refused, not thrown. */
export const SET_EXTRA_HTTP_HEADERS = defineTool({
  name: 'set_extra_http_headers',
  title: 'Set extra HTTP headers',
  description:
    'Set extra HTTP headers sent with every request from the session context (applies to all ' +
    'tabs). Replaces any previously-set extra headers. On a stealth session, headers owned by the ' +
    'presented identity (User-Agent, Accept-Language, Sec-CH-UA*) are refused and listed in the ' +
    '`rejected` field, since overriding them would desync the wire from what the page sees in ' +
    'JavaScript.',
  input: z.object({ session_id: z.string(), headers: z.record(z.string(), z.string()) }),
  output: z.object({
    session_id: z.string(),
    applied: z.number(),
    rejected: z.array(z.string()),
  }),
  annotations: annotations(false, false, true, false),
  pack: 'state',
  capability: 'mutate',
  errors: [...SESSION_ERRORS],
  since: SINCE,
});

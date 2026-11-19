/** @module contracts/tools/inspection — screenshot, snapshot, get_content, evaluate contracts */
import { z } from 'zod';
import { annotations, SEALED_TEXT_NOTE, SESSION_ERRORS, SINCE, TabId } from './shared.ts';
import { defineTool } from './types.ts';

/**
 * `screenshot` is the one content-block tool: the wire result is `[image, text?]`; this is the
 * additive `structuredContent` (`saved_to` only when `save_path` was given).
 */
export const ScreenshotResult = z.object({
  saved_to: z.string().optional(),
  width: z.number(),
  height: z.number(),
  bytes: z.number(),
});

/** `screenshot`: PNG as an MCP image block, optional sandboxed save, archived under the event id. */
export const SCREENSHOT = defineTool({
  name: 'screenshot',
  title: 'Screenshot',
  description:
    'Take a PNG screenshot of a tab and return it as an MCP image content block so ' +
    'vision-capable models can see it. When save_path is set the PNG is also written to ' +
    'disk (sandboxed under <data-dir>) and a { saved_to } block is included.',
  input: z.object({
    session_id: z.string(),
    full_page: z.boolean().default(false),
    clip: z
      .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
      .optional(),
    omit_background: z.boolean().default(false),
    save_path: z.string().optional(),
    tab_id: TabId,
  }),
  output: ScreenshotResult,
  annotations: annotations(true, false, true, false),
  pack: 'inspection',
  capability: 'read',
  errors: [...SESSION_ERRORS, 'TAB_NOT_FOUND', 'PATH_NOT_ALLOWED'],
  since: SINCE,
});

/** `snapshot`: ARIA accessibility tree as YAML. */
export const SNAPSHOT = defineTool({
  name: 'snapshot',
  title: 'Snapshot',
  description:
    "Return the tab's ARIA accessibility tree (YAML) — purpose-built for LLM consumption. " +
    SEALED_TEXT_NOTE,
  input: z.object({ session_id: z.string(), tab_id: TabId }),
  output: z.object({ session_id: z.string(), url: z.string(), tree: z.string() }),
  annotations: annotations(true, false, true, false),
  pack: 'inspection',
  capability: 'read',
  errors: [...SESSION_ERRORS, 'TAB_NOT_FOUND'],
  since: SINCE,
});

/** `get_content`'s default `max_chars`: about 25 000 tokens, what an agent can read in one result. */
export const GET_CONTENT_DEFAULT_MAX_CHARS = 100_000;

/** `get_content`: `page.content()`, at most `max_chars` characters (workload test 2026-11-17). */
export const GET_CONTENT = defineTool({
  name: 'get_content',
  title: 'Get content',
  description:
    'Return the current HTML content of a tab. While the tab is still navigating, waits up to ' +
    '5 s for the new page to reach domcontentloaded; if it is still navigating then, fails with ' +
    'WAIT_TIMEOUT, which is safe to retry. HTML longer than max_chars (default 100000) is cut ' +
    'to its first max_chars characters and the result says so (truncated, total_chars, notice); ' +
    'max_chars: 0 returns all of it. Web apps can be megabytes of HTML: snapshot is the ' +
    'readable view of a page. ' +
    SEALED_TEXT_NOTE,
  input: z.object({
    session_id: z.string(),
    tab_id: TabId,
    max_chars: z
      .number()
      .int()
      .min(0)
      .default(GET_CONTENT_DEFAULT_MAX_CHARS)
      .describe('At most this many characters of HTML (0 = no limit).'),
  }),
  output: z.object({
    session_id: z.string(),
    url: z.string(),
    html: z.string(),
    truncated: z.literal(true).optional(),
    total_chars: z.number().optional(),
    notice: z.string().optional(),
  }),
  annotations: annotations(true, false, true, false),
  pack: 'inspection',
  capability: 'read',
  errors: [...SESSION_ERRORS, 'TAB_NOT_FOUND', 'WAIT_TIMEOUT'],
  since: SINCE,
});

/**
 * `evaluate`: a lone function is wrapped as an IIFE, decided by a parse (core `evaluate-wrap`).
 * `result` is whatever the page returned; a page-side `undefined` is dropped by `JSON.stringify`,
 * so the dispatcher should coerce it to `null` for `structuredContent`.
 */
export const EVALUATE = defineTool({
  name: 'evaluate',
  title: 'Evaluate',
  description:
    'Evaluate a JavaScript expression in the tab context and return the result. ' +
    'An expression that is exactly one function (an arrow or function expression, async ' +
    'included) is called and its result returned; anything else, including an IIFE that is ' +
    'already invoked, runs as written. A page-side exception fails with SCRIPT_ERROR carrying ' +
    'its message. A session launched with disable_evaluate: true rejects this call with ' +
    'EVALUATE_DISABLED, as does a template session unless the operator allows evaluate for ' +
    'its template.',
  input: z.object({ session_id: z.string(), expression: z.string().min(1), tab_id: TabId }),
  output: z.object({ session_id: z.string(), result: z.unknown() }),
  annotations: annotations(false, false, false, true),
  pack: 'inspection',
  capability: 'mutate',
  errors: ['EVALUATE_DISABLED', ...SESSION_ERRORS, 'TAB_NOT_FOUND', 'SCRIPT_ERROR'],
  since: SINCE,
});

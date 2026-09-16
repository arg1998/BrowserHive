/** @module contracts/tools/inspection — screenshot, snapshot, get_content, evaluate contracts */
import { z } from 'zod';
import { annotations, SESSION_ERRORS, SINCE, TabId } from './shared.ts';
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
    "Return the tab's ARIA accessibility tree (YAML) — purpose-built for LLM consumption.",
  input: z.object({ session_id: z.string(), tab_id: TabId }),
  output: z.object({ session_id: z.string(), url: z.string(), tree: z.string() }),
  annotations: annotations(true, false, true, false),
  pack: 'inspection',
  capability: 'read',
  errors: [...SESSION_ERRORS, 'TAB_NOT_FOUND'],
  since: SINCE,
});

/** `get_content`: `page.content()`. */
export const GET_CONTENT = defineTool({
  name: 'get_content',
  title: 'Get content',
  description: 'Return the current HTML content of a tab.',
  input: z.object({ session_id: z.string(), tab_id: TabId }),
  output: z.object({ session_id: z.string(), url: z.string(), html: z.string() }),
  annotations: annotations(true, false, true, false),
  pack: 'inspection',
  capability: 'read',
  errors: [...SESSION_ERRORS, 'TAB_NOT_FOUND'],
  since: SINCE,
});

/**
 * `evaluate`: IIFE wrapping heuristic kept. `result` is whatever the page returned; a page-side
 * `undefined` is dropped by `JSON.stringify`, so the dispatcher should coerce it to `null` for
 * `structuredContent`.
 */
export const EVALUATE = defineTool({
  name: 'evaluate',
  title: 'Evaluate',
  description:
    'Evaluate a JavaScript expression in the tab context and return the result. ' +
    'Function-shaped strings are auto-wrapped as IIFEs. A session launched with ' +
    'disable_evaluate: true rejects this call with EVALUATE_DISABLED.',
  input: z.object({ session_id: z.string(), expression: z.string().min(1), tab_id: TabId }),
  output: z.object({ session_id: z.string(), result: z.unknown() }),
  annotations: annotations(false, false, false, true),
  pack: 'inspection',
  capability: 'mutate',
  errors: ['EVALUATE_DISABLED', ...SESSION_ERRORS, 'TAB_NOT_FOUND', 'SCRIPT_ERROR'],
  since: SINCE,
});

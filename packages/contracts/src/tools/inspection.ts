/** @module contracts/tools/inspection — screenshot, snapshot, get_content, get_text, evaluate contracts */
import { z } from 'zod';
import { annotations, SESSION_ERRORS, Selector, SINCE, TabId } from './shared.ts';
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

/** Default page size of `get_text` (characters). */
export const GET_TEXT_DEFAULT_MAX_CHARS = 20_000;

/** Default page size of `get_content` and `snapshot` (characters). */
export const PAGE_READ_DEFAULT_MAX_CHARS = 60_000;

/** The largest page any reading tool returns in one call (characters, about 50k tokens). */
export const PAGE_READ_MAX_CHARS_LIMIT = 200_000;

/** The version that added `get_text` and paging on the reading tools. */
const PAGE_READING_SINCE = '0.3.0';

/** `max_chars` of a reading tool: a page size in UTF-16 code units, bounded. */
function maxChars(fallback: number): z.ZodDefault<z.ZodNumber> {
  return z
    .number()
    .int()
    .min(1)
    .max(PAGE_READ_MAX_CHARS_LIMIT)
    .default(fallback)
    .describe(
      `Most characters to return in this call (default ${fallback}, at most ${PAGE_READ_MAX_CHARS_LIMIT}).`,
    );
}

/** `offset` of a reading tool: where this page starts (the previous call's `next_offset`). */
const Offset = z
  .number()
  .int()
  .nonnegative()
  .default(0)
  .describe("Character offset to start from: pass the previous call's next_offset.");

/** `selector` of a reading tool: scope the read to the first matching element. */
const ReadSelector = Selector.optional().describe(
  'Read only the first element matching this selector (ELEMENT_NOT_FOUND when nothing matches).',
);

/**
 * The paging fields every reading tool returns (`get_content`, `get_text`, `snapshot`). Lengths are
 * UTF-16 code units, as JavaScript counts them, and a page never ends inside a surrogate pair.
 */
const Paging = {
  /** Length of the whole text the pages are cut from. */
  total_chars: z.number().int().nonnegative(),
  /** True when the text continues after this page. */
  truncated: z.boolean(),
  /** Offset of the next page, or `null` when this page reached the end. */
  next_offset: z.number().int().nonnegative().nullable(),
} as const;

/** The paging sentence shared by the three reading tool descriptions. */
const PAGING_NOTE =
  'Long results are paged: when truncated is true, call again with offset set to next_offset ' +
  'until next_offset is null.';

/** `snapshot`: ARIA accessibility tree as YAML, optionally of one element, paged. */
export const SNAPSHOT = defineTool({
  name: 'snapshot',
  title: 'Snapshot',
  description:
    "Return the tab's ARIA accessibility tree (YAML) — purpose-built for LLM consumption. " +
    'With selector, only the subtree of the first matching element. At most max_chars ' +
    `characters (default ${PAGE_READ_DEFAULT_MAX_CHARS}) per call. ${PAGING_NOTE} ` +
    'The tree holds what the accessibility tree exposes: collapsed <details>, hidden tab panels ' +
    'and the line breaks of <pre> blocks are not in it; use get_text to read those.',
  input: z.object({
    session_id: z.string(),
    tab_id: TabId,
    selector: ReadSelector,
    max_chars: maxChars(PAGE_READ_DEFAULT_MAX_CHARS),
    offset: Offset,
  }),
  output: z.object({ session_id: z.string(), url: z.string(), tree: z.string(), ...Paging }),
  annotations: annotations(true, false, true, false),
  pack: 'inspection',
  capability: 'read',
  errors: [
    ...SESSION_ERRORS,
    'TAB_NOT_FOUND',
    'ELEMENT_NOT_FOUND',
    'INVALID_ARGUMENTS',
    'WAIT_TIMEOUT',
  ],
  since: SINCE,
});

/** `get_content`: `page.content()`, or one element's `outerHTML`, paged. */
export const GET_CONTENT = defineTool({
  name: 'get_content',
  title: 'Get content',
  description:
    'Return the current HTML content of a tab, or with selector the outerHTML of the first ' +
    `matching element. At most max_chars characters (default ${PAGE_READ_DEFAULT_MAX_CHARS}) ` +
    `are returned per call, so a large page arrives in pages. ${PAGING_NOTE} ` +
    'For readable text rather than markup, use get_text.',
  input: z.object({
    session_id: z.string(),
    tab_id: TabId,
    selector: ReadSelector,
    max_chars: maxChars(PAGE_READ_DEFAULT_MAX_CHARS),
    offset: Offset,
  }),
  output: z.object({ session_id: z.string(), url: z.string(), html: z.string(), ...Paging }),
  annotations: annotations(true, false, true, false),
  pack: 'inspection',
  capability: 'read',
  errors: [
    ...SESSION_ERRORS,
    'TAB_NOT_FOUND',
    'ELEMENT_NOT_FOUND',
    'INVALID_ARGUMENTS',
    'WAIT_TIMEOUT',
  ],
  since: SINCE,
});

/**
 * `get_text`: the readable text of a tab or of one element, read by BrowserHive's own script (in an
 * isolated world where the driver allows it), so it works when `evaluate` is disabled.
 */
export const GET_TEXT = defineTool({
  name: 'get_text',
  title: 'Get text',
  description:
    'Return the readable text of a tab as plain text with line breaks. Without selector it reads ' +
    "the <main> element, else the page's only <article>, else <body> without nav, header, " +
    'footer and aside; with selector, the first matching element. Code in <pre> keeps its line ' +
    'breaks, and collapsed <details> and inactive tab panels are included; script, style and ' +
    "hidden elements are skipped, and iframes are not read. It runs BrowserHive's own reader, " +
    'not page script, so it also works when evaluate is disabled. At most max_chars characters ' +
    `(default ${GET_TEXT_DEFAULT_MAX_CHARS}) per call. ${PAGING_NOTE}`,
  input: z.object({
    session_id: z.string(),
    tab_id: TabId,
    selector: ReadSelector,
    max_chars: maxChars(GET_TEXT_DEFAULT_MAX_CHARS),
    offset: Offset,
  }),
  output: z.object({ session_id: z.string(), url: z.string(), text: z.string(), ...Paging }),
  annotations: annotations(true, false, true, false),
  pack: 'inspection',
  capability: 'read',
  errors: [
    ...SESSION_ERRORS,
    'TAB_NOT_FOUND',
    'ELEMENT_NOT_FOUND',
    'INVALID_ARGUMENTS',
    'WAIT_TIMEOUT',
  ],
  since: PAGE_READING_SINCE,
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

/** @module contracts/tools/interaction — click, type_text, fill, press_key, hover, select_option, scroll, drag_and_drop contracts */
import { z } from 'zod';
import {
  annotations,
  SESSION_ERRORS,
  Selector,
  SelectorAck,
  SINCE,
  TabId,
  Timeout,
} from './shared.ts';
import { defineTool } from './types.ts';

/** Mouse button for `click`. */
export const MouseButton = z.enum(['left', 'right', 'middle']);
/** Keyboard modifiers held during `click`. */
export const KeyboardModifier = z.enum(['Alt', 'Control', 'ControlOrMeta', 'Meta', 'Shift']);
/** `scroll` modes: by a delta, to an absolute position, or bring a selector into view. */
export const ScrollMode = z.enum(['by', 'to', 'selector']);
/** `scroll` behaviour. */
export const ScrollBehavior = z.enum(['auto', 'smooth']);

const INTERACTION_ERRORS = [...SESSION_ERRORS, 'TAB_NOT_FOUND', 'ELEMENT_NOT_ACTIONABLE'] as const;

/** `click`: `page.click(selector, { button, clickCount, modifiers?, position?, timeout })`. */
export const CLICK = defineTool({
  name: 'click',
  title: 'Click',
  description: 'Click an element matching the selector.',
  input: z.object({
    session_id: z.string(),
    selector: Selector,
    button: MouseButton.default('left'),
    click_count: z.number().int().min(1).max(3).default(1),
    modifiers: z.array(KeyboardModifier).optional(),
    position: z.object({ x: z.number(), y: z.number() }).optional(),
    timeout: Timeout,
    tab_id: TabId,
  }),
  output: SelectorAck,
  annotations: annotations(false, false, false, true),
  pack: 'interaction',
  capability: 'mutate',
  errors: [...INTERACTION_ERRORS],
  since: SINCE,
});

/** `type_text`: per-character typing; humanized sessions raise the timeout budget. */
export const TYPE_TEXT = defineTool({
  name: 'type_text',
  title: 'Type text',
  description: 'Type text into the element one character at a time (simulates typing).',
  input: z.object({
    session_id: z.string(),
    selector: Selector,
    text: z.string(),
    delay: z.number().nonnegative().default(0),
    timeout: Timeout,
    tab_id: TabId,
  }),
  output: SelectorAck,
  annotations: annotations(false, false, false, true),
  pack: 'interaction',
  capability: 'mutate',
  errors: [...INTERACTION_ERRORS],
  since: SINCE,
});

/** `fill`: always the native `page.fill`, never humanized. */
export const FILL = defineTool({
  name: 'fill',
  title: 'Fill',
  description: 'Fill an input/textarea directly (fast, no per-character typing).',
  input: z.object({
    session_id: z.string(),
    selector: Selector,
    value: z.string(),
    timeout: Timeout,
    tab_id: TabId,
  }),
  output: SelectorAck,
  annotations: annotations(false, false, true, true),
  pack: 'interaction',
  capability: 'mutate',
  errors: [...INTERACTION_ERRORS],
  since: SINCE,
});

/** `press_key`: with `selector` → `page.press` (wrapped); without → `keyboard.press` (no timeout). */
export const PRESS_KEY = defineTool({
  name: 'press_key',
  title: 'Press key',
  description: 'Press a keyboard key. If a selector is given, focuses it first.',
  input: z.object({
    session_id: z.string(),
    key: z.string().min(1),
    selector: Selector.optional(),
    timeout: Timeout,
    tab_id: TabId,
  }),
  output: z.object({ session_id: z.string(), key: z.string(), ok: z.literal(true) }),
  annotations: annotations(false, false, false, true),
  pack: 'interaction',
  capability: 'mutate',
  errors: [...INTERACTION_ERRORS],
  since: SINCE,
});

/** `hover`: `page.hover` (humanized when the session asks for it). */
export const HOVER = defineTool({
  name: 'hover',
  title: 'Hover',
  description: 'Hover the mouse over an element.',
  input: z.object({ session_id: z.string(), selector: Selector, timeout: Timeout, tab_id: TabId }),
  output: SelectorAck,
  annotations: annotations(false, false, true, true),
  pack: 'interaction',
  capability: 'mutate',
  errors: [...INTERACTION_ERRORS],
  since: SINCE,
});

/** `select_option`: `page.selectOption`; returns Playwright's selected values. */
export const SELECT_OPTION = defineTool({
  name: 'select_option',
  title: 'Select option',
  description: 'Select one or more options in a <select> element by value.',
  input: z.object({
    session_id: z.string(),
    selector: Selector,
    values: z.array(z.string()).min(1, 'values must include at least one option'),
    timeout: Timeout,
    tab_id: TabId,
  }),
  output: z.object({ session_id: z.string(), selector: z.string(), selected: z.array(z.string()) }),
  annotations: annotations(false, false, true, true),
  pack: 'interaction',
  capability: 'mutate',
  errors: [...INTERACTION_ERRORS],
  since: SINCE,
});

/**
 * `scroll` input. Kept as a flat `z.object` + `superRefine` (not a discriminated union) so the
 * JSON Schema root is `type: "object"`; strict MCP clients reject `oneOf`/`allOf` roots.
 */
export const ScrollInput = z
  .object({
    session_id: z.string(),
    mode: ScrollMode,
    dx: z.number().default(0),
    dy: z.number().default(0),
    x: z.number().optional(),
    y: z.number().optional(),
    selector: Selector.optional(),
    behavior: ScrollBehavior.default('auto'),
    timeout: Timeout,
    tab_id: TabId,
  })
  .superRefine((v, ctx) => {
    if (v.mode === 'to' && (v.x === undefined || v.y === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'mode="to" requires x and y' });
    }
    if (v.mode === 'selector' && v.selector === undefined) {
      ctx.addIssue({ code: 'custom', message: 'mode="selector" requires selector' });
    }
  });

/** `scroll`: three modes; returns the resulting `scrollX`/`scrollY`. */
export const SCROLL = defineTool({
  name: 'scroll',
  title: 'Scroll',
  description:
    'Scroll a tab: mode="by" scrolls by (dx,dy); mode="to" scrolls to (x,y); mode="selector" ' +
    'brings an element into view. Returns the resulting scroll offset.',
  input: ScrollInput,
  output: z.object({ session_id: z.string(), x: z.number(), y: z.number() }),
  annotations: annotations(false, false, false, true),
  pack: 'interaction',
  capability: 'mutate',
  errors: [...INTERACTION_ERRORS],
  since: SINCE,
});

/** `drag_and_drop`: always native; the reported selector is `` `${source} → ${target}` ``. */
export const DRAG_AND_DROP = defineTool({
  name: 'drag_and_drop',
  title: 'Drag and drop',
  description: 'Drag the source element and drop it on the target element.',
  input: z.object({
    session_id: z.string(),
    source_selector: Selector,
    target_selector: Selector,
    timeout: Timeout,
    tab_id: TabId,
  }),
  output: z.object({ session_id: z.string(), ok: z.literal(true) }),
  annotations: annotations(false, false, false, true),
  pack: 'interaction',
  capability: 'mutate',
  errors: [...INTERACTION_ERRORS],
  since: SINCE,
});

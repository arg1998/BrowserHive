/** @module contracts/tools/waits — wait_for_selector and wait_for_load_state contracts */
import { z } from 'zod';
import { annotations, SESSION_ERRORS, SINCE, TabId, Timeout } from './shared.ts';
import { defineTool } from './types.ts';

/** Element states `wait_for_selector` can wait for. */
export const SelectorState = z.enum(['attached', 'detached', 'visible', 'hidden']);
/** Load states `wait_for_load_state` can wait for (no `commit`, unlike `WaitUntil`). */
export const LoadState = z.enum(['load', 'domcontentloaded', 'networkidle']);

const WAIT_ERRORS = [...SESSION_ERRORS, 'TAB_NOT_FOUND', 'WAIT_TIMEOUT'] as const;

/** `wait_for_selector`: `page.waitForSelector(selector, { state, timeout })`. */
export const WAIT_FOR_SELECTOR = defineTool({
  name: 'wait_for_selector',
  title: 'Wait for selector',
  description: 'Wait for an element to reach the given state (attached/detached/visible/hidden).',
  input: z.object({
    session_id: z.string(),
    selector: z.string().min(1),
    state: SelectorState.default('visible'),
    timeout: Timeout,
    tab_id: TabId,
  }),
  output: z.object({ session_id: z.string(), selector: z.string(), state: SelectorState }),
  annotations: annotations(true, false, true, false),
  pack: 'waits',
  capability: 'read',
  errors: [...WAIT_ERRORS],
  since: SINCE,
});

/** `wait_for_load_state`: `page.waitForLoadState(state, { timeout })`. */
export const WAIT_FOR_LOAD_STATE = defineTool({
  name: 'wait_for_load_state',
  title: 'Wait for load state',
  description: 'Wait for the page to reach a load state (load/domcontentloaded/networkidle).',
  input: z.object({
    session_id: z.string(),
    state: LoadState.default('load'),
    timeout: Timeout,
    tab_id: TabId,
  }),
  output: z.object({ session_id: z.string(), state: LoadState }),
  annotations: annotations(true, false, true, false),
  pack: 'waits',
  capability: 'read',
  errors: [...WAIT_ERRORS],
  since: SINCE,
});

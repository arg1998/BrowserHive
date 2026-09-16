/** @module contracts/tools/dialogs — accept_next_dialog and dismiss_next_dialog contracts */
import { z } from 'zod';
import { annotations, SESSION_ERRORS, SINCE, TabId } from './shared.ts';
import { defineTool } from './types.ts';

/** Both dialog tools answer `{ session_id, armed: true }`. */
export const ArmedResult = z.object({ session_id: z.string(), armed: z.literal(true) });

/** `accept_next_dialog`: one-shot `page.once('dialog')`, auto-disarmed after 60 s. */
export const ACCEPT_NEXT_DIALOG = defineTool({
  name: 'accept_next_dialog',
  title: 'Accept next dialog',
  description:
    'Arm a one-shot handler that accepts the next JavaScript dialog (alert/confirm/prompt) on ' +
    'the tab. For a prompt, prompt_text is entered first. Auto-disarms after one dialog or 60s.',
  input: z.object({ session_id: z.string(), prompt_text: z.string().optional(), tab_id: TabId }),
  output: ArmedResult,
  annotations: annotations(false, false, true, false),
  pack: 'dialogs',
  capability: 'mutate',
  errors: [...SESSION_ERRORS, 'TAB_NOT_FOUND'],
  since: SINCE,
});

/** `dismiss_next_dialog`: one-shot dismiss, auto-disarmed after 60 s. */
export const DISMISS_NEXT_DIALOG = defineTool({
  name: 'dismiss_next_dialog',
  title: 'Dismiss next dialog',
  description:
    'Arm a one-shot handler that dismisses (cancels) the next JavaScript dialog on the tab. ' +
    'Auto-disarms after one dialog or 60s.',
  input: z.object({ session_id: z.string(), tab_id: TabId }),
  output: ArmedResult,
  annotations: annotations(false, false, true, false),
  pack: 'dialogs',
  capability: 'mutate',
  errors: [...SESSION_ERRORS, 'TAB_NOT_FOUND'],
  since: SINCE,
});

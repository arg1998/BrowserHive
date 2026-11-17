/** @module app/templates/relogin-executor — the `template.relogin` act button (spec 13 §8.6, D-41): a press only queues a window re-login, run through the same service and scope (`templates:login`) as the dashboard; the window opens on **Show window**. */

import type { ActionExecutor } from '../notifications/actions.ts';
import type { TemplateReloginService } from './template-relogin.ts';

/** The executor of `template.relogin` (args `{template_id, site_id}`; the presser is recorded). */
export function reloginActionExecutor(
  relogin: Pick<TemplateReloginService, 'queue'>,
): ActionExecutor {
  return {
    scope: 'templates:login',
    async run(args, actor) {
      const view = await relogin.queue(
        String(args['template_id'] ?? ''),
        String(args['site_id'] ?? ''),
        actor,
      );
      return view.state === 'queued'
        ? 'Queued. Press Show window on the template page to open it.'
        : 'A re-login is already running for this template.';
    },
  };
}

/** @module infra/browsers/host-responses — every response of a template host handed to the site-pack watcher (spec 13 §9.4 `device-bound-session`: response headers, which a route that falls back never sees). Observation only: it never changes a request, and a watcher that throws is logged and ignored (fail-open, §3.8). */

import type { BrowserContext, Response } from 'patchright';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Logger } from '../../ports/logger.ts';
import type { TemplatePageWatcher } from '../../ports/template-host.ts';

/** Subscribes the host context's `response` event; nothing is read unless the watcher wants it. */
export function observeHostResponses(
  context: BrowserContext,
  templateId: string,
  watcher: () => TemplatePageWatcher | null,
  log: Logger,
): void {
  context.on('response', (response: Response) => {
    const current = watcher();
    if (current?.responseReceived === undefined) return;
    try {
      current.responseReceived(templateId, {
        url: response.url(),
        headers: () => response.headers(),
      });
    } catch (err) {
      log.debug('response watcher threw', { err: serializeError(err) });
    }
  });
}

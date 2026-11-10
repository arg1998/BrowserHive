/** @module app/templates/unavailable-runtime — the `TemplateRuntime` used until the host supervisor exists (templates T1a-2): no host ever starts, so every template reads as stopped with no sessions and every launch answers `TEMPLATE_UNAVAILABLE`. Also the runtime under `templates=false`, where launches never reach it. */

import { ERROR_REGISTRY, renderMessage } from '@browserhive/contracts/errors';
import type { Session } from '../../domain/session/session.ts';
import { AppError } from '../../kernel/errors/app-error.ts';
import {
  STOPPED_HOST,
  type TemplateHostView,
  type TemplateLaunchRequest,
  type TemplateRuntime,
} from '../../ports/template-runtime.ts';

/** How long `TEMPLATE_UNAVAILABLE` asks an agent to wait. */
export const UNAVAILABLE_RETRY_AFTER_MS = 5_000;

/** A runtime without hosts. */
export class UnavailableTemplateRuntime implements TemplateRuntime {
  host(): TemplateHostView {
    return STOPPED_HOST;
  }

  liveSessions(): readonly string[] {
    return [];
  }

  launch(request: TemplateLaunchRequest): Promise<Session> {
    const details = {
      template: request.template.name,
      reason: 'starting' as const,
      retry_after_ms: UNAVAILABLE_RETRY_AFTER_MS,
    };
    return Promise.reject(
      new AppError('TEMPLATE_UNAVAILABLE', details, {
        publicMessage: renderMessage(ERROR_REGISTRY.TEMPLATE_UNAVAILABLE.message, details),
        message: 'template hosts are not available in this build (templates T1a-2)',
      }),
    );
  }

  shutdown(): Promise<readonly string[]> {
    return Promise.resolve([]);
  }
}

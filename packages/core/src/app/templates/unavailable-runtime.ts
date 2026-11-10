/** @module app/templates/unavailable-runtime — the `TemplateRuntime` used until the host supervisor exists (templates T1a-2): no host ever starts, so every template reads as stopped with no sessions and every launch answers `TEMPLATE_UNAVAILABLE`. Also the runtime under `templates=false`, where launches never reach it. */

import { ERROR_REGISTRY, renderMessage } from '@browserhive/contracts/errors';
import type { Session } from '../../domain/session/session.ts';
import { AppError } from '../../kernel/errors/app-error.ts';
import type { SignInRemoval } from '../../ports/template-host.ts';
import {
  type SharedWindowView,
  STOPPED_HOST,
  type TemplateHostOps,
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

/** `CONFLICT`: templates are off on this server (`templates=false`). */
function templatesOff(): AppError<'CONFLICT'> {
  return new AppError(
    'CONFLICT',
    {},
    { publicMessage: 'Session templates are turned off on this server (templates=false).' },
  );
}

/** Host operations without hosts (`templates=false`): nothing runs, recording is refused. */
export class UnavailableTemplateHostOps implements TemplateHostOps {
  async jar(): Promise<null> {
    return null;
  }

  async sharedWindows(): Promise<readonly SharedWindowView[]> {
    return [];
  }

  removeSignIn(): Promise<SignInRemoval> {
    return Promise.reject(templatesOff());
  }

  clearProfileSecrets(): Promise<void> {
    return Promise.reject(templatesOff());
  }

  openRecording(): Promise<Session> {
    return Promise.reject(templatesOff());
  }

  recordingOf(): null {
    return null;
  }

  async closeRecording(): Promise<void> {
    return;
  }
}

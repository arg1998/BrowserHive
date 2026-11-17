/** @module app/templates/launch-recheck — a template launch checks its gate again once its session is registered (deferred D24, review #79 L-1): an operator edit (re-seal, revoke, disable, delete) that raced the launch between its gate and its registration closes the session and answers the template's own code, never `INTERNAL_ERROR`. */

import type { Session } from '../../domain/session/session.ts';
import type { AppError } from '../../kernel/errors/app-error.ts';
import { isAppError } from '../../kernel/errors/app-error.ts';
import type { Repositories, TemplateRecord } from '../../ports/persistence/index.ts';
import { disabled, notFoundForAgent } from './template-errors.ts';

/** What a launch knew at its gate. */
export interface LaunchGateFacts {
  readonly name: string;
  readonly templateId: string;
  /** The gate again, on the current row: `true` = the caller may still launch it. */
  readonly allowed: (current: TemplateRecord) => boolean;
}

/**
 * The refusal a launch answers when the template changed under it, or `null` when it is still
 * launchable: deleted or no longer allowed → `TEMPLATE_NOT_FOUND`, disabled → `TEMPLATE_DISABLED`.
 */
export async function staleLaunchRefusal(
  repos: Pick<Repositories, 'templates'>,
  facts: LaunchGateFacts,
): Promise<AppError<'TEMPLATE_NOT_FOUND' | 'TEMPLATE_DISABLED'> | null> {
  const current = await repos.templates.get(facts.templateId);
  if (current === null || !facts.allowed(current)) return notFoundForAgent(facts.name);
  if (current.status === 'disabled') return disabled(facts.name);
  return null;
}

/**
 * Runs `launch`, then checks the gate again. A session launched past a racing edit is closed; a
 * launch that failed because the edit closed it answers the template's code.
 */
export async function launchWithRecheck(
  repos: Pick<Repositories, 'templates'>,
  facts: LaunchGateFacts,
  launch: () => Promise<Session>,
  close: (sessionId: string) => Promise<unknown>,
): Promise<Session> {
  let session: Session;
  try {
    session = await launch();
  } catch (err) {
    // A typed refusal stands; anything else may be the edit's close: answer its code if so.
    if (isAppError(err) && err.code !== 'INTERNAL_ERROR') throw err;
    const refusal = await staleLaunchRefusal(repos, facts).catch(() => null);
    throw refusal ?? err;
  }
  const refusal = await staleLaunchRefusal(repos, facts);
  if (refusal !== null) {
    await close(session.id).catch(() => undefined);
    throw refusal;
  }
  return session;
}

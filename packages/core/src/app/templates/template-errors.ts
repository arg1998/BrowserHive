/** @module app/templates/template-errors — the typed refusals of the template service, with the registry's public texts (spec 13 §12). Agent-facing ones follow the wording rule of §5. */

import { ERROR_REGISTRY, renderMessage } from '@browserhive/contracts/errors';
import { AppError } from '../../kernel/errors/app-error.ts';

/** One field-level issue, in the `VALIDATION_FAILED` / `INVALID_ARGUMENTS` shapes. */
interface Issue {
  readonly path: string;
  readonly message: string;
}

/** `TEMPLATE_NOT_FOUND` for agents: identical for unknown, unauthorized and still-recording names. */
export function notFoundForAgent(name: string): AppError<'TEMPLATE_NOT_FOUND'> {
  const details = { template: name };
  return new AppError('TEMPLATE_NOT_FOUND', details, {
    publicMessage: renderMessage(ERROR_REGISTRY.TEMPLATE_NOT_FOUND.message, details),
  });
}

/** `TEMPLATE_NOT_FOUND` for operators, by id. */
export function notFoundForOperator(templateId: string): AppError<'TEMPLATE_NOT_FOUND'> {
  return new AppError(
    'TEMPLATE_NOT_FOUND',
    { template: templateId },
    { publicMessage: `No session template '${templateId}'.` },
  );
}

/** `TEMPLATE_NAME_TAKEN`. */
export function nameTaken(name: string): AppError<'TEMPLATE_NAME_TAKEN'> {
  return new AppError(
    'TEMPLATE_NAME_TAKEN',
    { name },
    { publicMessage: renderMessage(ERROR_REGISTRY.TEMPLATE_NAME_TAKEN.message, { name }) },
  );
}

/** `TEMPLATE_IN_USE`: live sessions, launches in flight counted with them. */
export function inUse(templateId: string, live: number): AppError<'TEMPLATE_IN_USE'> {
  const details = { template_id: templateId, live_sessions: live };
  return new AppError('TEMPLATE_IN_USE', details, {
    publicMessage: renderMessage(ERROR_REGISTRY.TEMPLATE_IN_USE.message, details),
  });
}

/** `TEMPLATE_DISABLED` with `reason: 'disabled'`. */
export function disabled(name: string): AppError<'TEMPLATE_DISABLED'> {
  const details = { template: name, reason: 'disabled' as const };
  return new AppError('TEMPLATE_DISABLED', details, {
    publicMessage: renderMessage(ERROR_REGISTRY.TEMPLATE_DISABLED.message, details),
  });
}

/** `VALIDATION_FAILED` with field issues; the message is the first issue (03 §5). */
export function validationFailed(
  issues: readonly (Issue & { readonly code: string })[],
): AppError<'VALIDATION_FAILED'> {
  const first = issues[0];
  return new AppError(
    'VALIDATION_FAILED',
    { issues: [...issues] },
    {
      publicMessage: first === undefined ? 'Invalid template.' : `${first.path}: ${first.message}`,
    },
  );
}

/** `INVALID_ARGUMENTS` with one issue per refused option; the message is the first (02 §2.3). */
export function invalidArguments(issues: readonly Issue[]): AppError<'INVALID_ARGUMENTS'> {
  const first = issues[0];
  return new AppError(
    'INVALID_ARGUMENTS',
    { issues: [...issues] },
    {
      publicMessage: first === undefined ? 'invalid arguments' : `${first.path}: ${first.message}`,
    },
  );
}

/** `CONFLICT` for a second delete while one is running. */
export function deleteRunning(templateId: string): AppError<'CONFLICT'> {
  return new AppError(
    'CONFLICT',
    {},
    { publicMessage: `Template '${templateId}' is already being deleted.` },
  );
}

/** `CONFLICT`: a restore, seed or clearing of saved passwords holds the template. */
export function operationRunning(templateId: string): AppError<'CONFLICT'> {
  return new AppError(
    'CONFLICT',
    {},
    {
      publicMessage: `An operation on template '${templateId}' is running (a restore, a seed or clearing saved passwords); retry when it finishes.`,
    },
  );
}

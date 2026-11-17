/** @module app/site-packs/registry-errors — the registry's typed refusals with the error registry's public texts (spec 13 §11.1, §12). */

import { ERROR_REGISTRY, renderMessage } from '@browserhive/contracts/errors';
import { issuesText } from '../../domain/site-packs/load.ts';
import type { PackIssue } from '../../domain/site-packs/refine.ts';
import { AppError } from '../../kernel/errors/app-error.ts';

/** `SITE_PACK_NOT_FOUND`. */
export function packNotFound(packId: string): AppError<'SITE_PACK_NOT_FOUND'> {
  const details = { pack_id: packId };
  return new AppError('SITE_PACK_NOT_FOUND', details, {
    publicMessage: renderMessage(ERROR_REGISTRY.SITE_PACK_NOT_FOUND.message, details),
  });
}

/** `SITE_PACK_UPDATE_NOT_PENDING`. */
export function notPending(
  packId: string,
  version: number,
): AppError<'SITE_PACK_UPDATE_NOT_PENDING'> {
  const details = { pack_id: packId, version };
  return new AppError('SITE_PACK_UPDATE_NOT_PENDING', details, {
    publicMessage: renderMessage(ERROR_REGISTRY.SITE_PACK_UPDATE_NOT_PENDING.message, details),
  });
}

/** `SITE_PACK_INVALID` with its issues (`issues_text` fills the message slot). */
export function packInvalid(
  source: string,
  issues: readonly PackIssue[],
): AppError<'SITE_PACK_INVALID'> {
  const list = issues.length === 0 ? [{ path: '', message: 'invalid' }] : issues;
  const details = {
    source,
    issues: list.map((i) => ({ path: i.path, message: i.message })),
    issues_text: issuesText(list),
  };
  return new AppError('SITE_PACK_INVALID', details, {
    publicMessage: renderMessage(ERROR_REGISTRY.SITE_PACK_INVALID.message, details),
  });
}

/** `CONFLICT` with an operator-facing message. */
export function packConflict(message: string): AppError<'CONFLICT'> {
  return new AppError('CONFLICT', {}, { publicMessage: message });
}

/** `VALIDATION_FAILED` on one field. */
export function packValidation(
  path: string,
  message: string,
  code: string,
): AppError<'VALIDATION_FAILED'> {
  return new AppError(
    'VALIDATION_FAILED',
    { issues: [{ path, message, code }] },
    { publicMessage: message },
  );
}

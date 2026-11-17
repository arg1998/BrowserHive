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

/** `SITE_PACK_DOMAIN_TAKEN`: content claims a domain another pack covers (spec 13 §9.10). */
export function domainTaken(
  packId: string,
  domain: string,
  owner: string,
): AppError<'SITE_PACK_DOMAIN_TAKEN'> {
  const details = { pack_id: packId, domain, owner };
  return new AppError('SITE_PACK_DOMAIN_TAKEN', details, {
    publicMessage: renderMessage(ERROR_REGISTRY.SITE_PACK_DOMAIN_TAKEN.message, details),
  });
}

/** `SITE_PACK_NO_PREVIOUS`. */
export function noPrevious(packId: string): AppError<'SITE_PACK_NO_PREVIOUS'> {
  const details = { pack_id: packId };
  return new AppError('SITE_PACK_NO_PREVIOUS', details, {
    publicMessage: renderMessage(ERROR_REGISTRY.SITE_PACK_NO_PREVIOUS.message, details),
  });
}

/** `SITE_PACK_NO_LOCAL_FILE`. */
export function noLocalFile(packId: string): AppError<'SITE_PACK_NO_LOCAL_FILE'> {
  const details = { pack_id: packId };
  return new AppError('SITE_PACK_NO_LOCAL_FILE', details, {
    publicMessage: renderMessage(ERROR_REGISTRY.SITE_PACK_NO_LOCAL_FILE.message, details),
  });
}

/** `SITE_PACK_APPROVAL_REQUIRED` with the offer the operator must review (spec 13 §9.6). */
export function approvalRequired(
  siteId: string,
  packId: string,
  offer: { readonly version: number; readonly sha256: string; readonly release: string | null },
): AppError<'SITE_PACK_APPROVAL_REQUIRED'> {
  const details = {
    site_id: siteId,
    pack_id: packId,
    version: offer.version,
    sha256: offer.sha256,
    source: 'bundled',
    release: offer.release,
  };
  return new AppError('SITE_PACK_APPROVAL_REQUIRED', details, {
    publicMessage: renderMessage(ERROR_REGISTRY.SITE_PACK_APPROVAL_REQUIRED.message, details),
  });
}

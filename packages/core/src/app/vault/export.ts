/** @module app/vault/export — the v3 export/import document: wire (snake_case, contracts zod) ↔ persistence records. */

import {
  VAULT_EXPORT_VERSION,
  VaultExportDocument as WireExportDocument,
} from '@browserhive/contracts/http';
import { mergeBinding } from '../../domain/vault/bindings.ts';
import { mergePolicy } from '../../domain/vault/policies.ts';
import { AppError } from '../../kernel/errors/app-error.ts';
import type { VaultExportDocument } from '../../ports/persistence/records.ts';

/** Wire shape of the export document. */
export type VaultExportWire = WireExportDocument;

/** Records → wire document (timestamps and versions dropped: the file is hand-editable). */
export function toWireExport(doc: VaultExportDocument): VaultExportWire {
  return {
    version: VAULT_EXPORT_VERSION,
    bindings: doc.bindings.map((b) => ({
      handle: b.handle,
      title: b.title,
      item_name: b.itemName,
      item_id: b.itemId,
      group_id: b.groupId,
      allowed_origins: [...b.allowedOrigins],
      authorized_principals: [...b.authorizedPrincipals],
      authorized_session_slugs: [...b.authorizedSessionSlugs],
      allow_all_sessions: b.allowAllSessions,
      redact_username: b.redactUsername,
      require_no_evaluate: b.requireNoEvaluate,
      dashboard_confirm: b.dashboardConfirm,
    })),
    policies: doc.policies.map((p) => ({
      group_id: p.groupId,
      access_mode: p.accessMode,
      allow_all_sessions: p.allowAllSessions,
      session_slug_globs: [...p.sessionSlugGlobs],
      authorized_principals: [...p.authorizedPrincipals],
      dashboard_confirm: p.dashboardConfirm,
      require_no_evaluate: p.requireNoEvaluate,
      redact_username: p.redactUsername,
    })),
  };
}

/**
 * Parses an untrusted import body with the contracts schema and normalises it into records
 * (origins lowercased, lists deduped, timestamps stamped `now`).
 * @throws `VALIDATION_FAILED` with per-field issues.
 */
export function fromWireExport(body: unknown, now: number): VaultExportDocument {
  const parsed = WireExportDocument.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', {
      issues: parsed.error.issues.map((i) => ({
        path: i.path.map(String).join('.'),
        message: i.message,
        code: i.code,
      })),
    });
  }
  const bindings = parsed.data.bindings.flatMap((b) => {
    const record = mergeBinding(
      b.handle,
      {
        title: b.title,
        itemName: b.item_name,
        itemId: b.item_id,
        groupId: b.group_id,
        allowedOrigins: b.allowed_origins,
        authorizedPrincipals: b.authorized_principals,
        authorizedSessionSlugs: b.authorized_session_slugs,
        allowAllSessions: b.allow_all_sessions,
        redactUsername: b.redact_username,
        requireNoEvaluate: b.require_no_evaluate,
        dashboardConfirm: b.dashboard_confirm,
      },
      null,
      now,
    );
    return record === null ? [] : [record];
  });
  const policies = parsed.data.policies.map((p) =>
    mergePolicy(
      p.group_id,
      {
        accessMode: p.access_mode,
        allowAllSessions: p.allow_all_sessions,
        sessionSlugGlobs: p.session_slug_globs,
        authorizedPrincipals: p.authorized_principals,
        dashboardConfirm: p.dashboard_confirm,
        requireNoEvaluate: p.require_no_evaluate,
        redactUsername: p.redact_username,
      },
      null,
      now,
    ),
  );
  return { version: 3, bindings, policies };
}

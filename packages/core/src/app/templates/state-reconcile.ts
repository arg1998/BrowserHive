/** @module app/templates/state-reconcile — the boot pass over template state files (spec 13 §2.4): leftover `.tmp` files and version files without a row are deleted (a row without a file reads as unreadable), files on an unknown key record `TEMPLATE_KEY_MISMATCH`, and files without any key `TEMPLATE_KEY_MISSING`. */

import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { DegradationReporter } from '../../ports/degradation-reporter.ts';
import type { Logger } from '../../ports/logger.ts';
import type { Repositories } from '../../ports/persistence/index.ts';
import type { StateSlot, TemplateStateStore } from '../../ports/template-state.ts';

/** What the boot pass found. */
export interface StateReconcileResult {
  /** Templates with encrypted files. */
  readonly templatesWithFiles: readonly string[];
  /** Version files deleted because no row names them. */
  readonly orphansRemoved: number;
  /** Per template, the slots written with a key this process does not hold. */
  readonly mismatched: ReadonlyMap<string, readonly StateSlot[]>;
  /** Files exist and no key resolves. */
  readonly keyMissing: boolean;
}

/** Collaborators of {@link reconcileTemplateState}. */
export interface StateReconcileDeps {
  readonly store: TemplateStateStore;
  readonly repos: Pick<Repositories, 'templates' | 'templateVersions'>;
  readonly degradations: DegradationReporter;
  readonly logger: Logger;
}

/** Runs once at boot, before any host starts. Never throws. */
export async function reconcileTemplateState(
  deps: StateReconcileDeps,
): Promise<StateReconcileResult> {
  const log = deps.logger.child({ module: 'templates.state' });
  const { store } = deps;
  const ids = await store.templatesWithFiles();
  const rows = await deps.repos.templateVersions.listAll().catch((err: unknown) => {
    log.warn('versions unreadable', { err: serializeError(err) });
    return null;
  });
  const known = new Set((rows ?? []).map((r) => `${r.templateId} ${r.version}`));
  const keys = new Set(
    [store.keys.current?.keyId, store.keys.previous?.keyId].filter((k) => k !== undefined),
  );
  let orphansRemoved = 0;
  const mismatched = new Map<string, StateSlot[]>();
  for (const templateId of ids) {
    try {
      await store.removeTemporaries(templateId);
      for (const file of await store.files(templateId)) {
        if (rows !== null && file.slot !== 'latest' && !known.has(`${templateId} ${file.slot}`)) {
          await store.remove(templateId, file.slot);
          orphansRemoved += 1;
          log.info('orphan version removed', { templateId, version: file.slot });
          continue;
        }
        if (keys.size > 0 && (file.keyId === null || !keys.has(file.keyId))) {
          mismatched.set(templateId, [...(mismatched.get(templateId) ?? []), file.slot]);
        }
      }
    } catch (err) {
      log.warn('files not reconciled', { templateId, err: serializeError(err) });
    }
  }
  const keyMissing = store.keys.current === null && ids.length > 0;
  if (keyMissing) {
    deps.degradations.report({
      code: 'TEMPLATE_KEY_MISSING',
      severity: 'error',
      message: `encrypted template files exist but no template key resolves (${ids.length} template(s))`,
      details: { template_ids: [...ids] },
    });
  }
  for (const [templateId, versions] of mismatched) {
    deps.degradations.report({
      code: 'TEMPLATE_KEY_MISMATCH',
      severity: 'warn',
      message: `template ${templateId} has ${versions.length} file(s) written with another key`,
      details: { template_id: templateId, versions: [...versions] },
    });
  }
  return { templatesWithFiles: ids, orphansRemoved, mismatched, keyMissing };
}

/** @module infra/fs/template-rekey — `browserhive templates rekey` (spec 13 §2.4): every checkpoint and version file read with the old (or any known) key and rewritten with the current key (`.tmp`, `fsync`, rename), its row's `key_id` updated. Files already on the current key are skipped but their rows are still reconciled, so an interrupted run can simply be repeated. */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { StateSlot, TemplateKey } from '../../domain/templates/envelope.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { TemplateStateFileRecord } from '../../ports/persistence/index.ts';
import { type FileTemplateStateStore, stateFileName } from './template-state-store.ts';

/** One file `rekey` could not rewrite. */
export interface RekeyFailure {
  readonly templateId: string;
  readonly slot: StateSlot;
  readonly reason: string;
}

/** What one `rekey` run did. */
export interface RekeyResult {
  readonly rewritten: number;
  readonly skipped: number;
  readonly failed: readonly RekeyFailure[];
}

/** Inputs of {@link rekeyTemplateFiles}. */
export interface RekeyInput {
  readonly store: FileTemplateStateStore;
  /** The key every file is rewritten with. */
  readonly current: TemplateKey;
  /** The key the files were written with (`--oldKeyEnv`). */
  readonly old: TemplateKey;
  /** Records a numbered version's file facts in its row (`template_versions.key_id`, size, hash). */
  readonly updateRow: (
    templateId: string,
    version: number,
    file: TemplateStateFileRecord,
  ) => Promise<void>;
  /** Called after each file (progress output). */
  readonly onFile?: (event: {
    readonly templateId: string;
    readonly slot: StateSlot;
    readonly outcome: 'rewritten' | 'skipped' | 'failed';
  }) => void;
}

async function fileFacts(
  store: FileTemplateStateStore,
  templateId: string,
  slot: StateSlot,
  keyId: string,
): Promise<TemplateStateFileRecord> {
  const bytes = await readFile(join(store.dirOf(templateId), stateFileName(slot)));
  return {
    sizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    keyId,
  };
}

/** Re-encrypts every template file that is not on `current` (spec 13 §2.4 rotation). */
export async function rekeyTemplateFiles(input: RekeyInput): Promise<RekeyResult> {
  const { store, current } = input;
  let rewritten = 0;
  let skipped = 0;
  const failed: RekeyFailure[] = [];
  for (const templateId of await store.templatesWithFiles()) {
    await store.removeTemporaries(templateId);
    for (const file of await store.files(templateId)) {
      const slot = file.slot;
      try {
        let facts: TemplateStateFileRecord;
        if (file.keyId === current.keyId) {
          facts = await fileFacts(store, templateId, slot, current.keyId);
          skipped += 1;
          input.onFile?.({ templateId, slot, outcome: 'skipped' });
        } else {
          const { state } = await store.readWithKey(templateId, slot, [input.old]);
          facts = await store.writeWith(templateId, slot, state, current);
          rewritten += 1;
          input.onFile?.({ templateId, slot, outcome: 'rewritten' });
        }
        // Reconciled every time: an interrupted run may have renamed the file before its row moved.
        if (slot !== 'latest') {
          await input.updateRow(templateId, slot, facts);
          // The meta beside the file names the key too (review #79 L-4).
          await store.patchMeta(templateId, slot, facts);
        }
      } catch (err) {
        failed.push({ templateId, slot, reason: serializeError(err).message });
        input.onFile?.({ templateId, slot, outcome: 'failed' });
      }
    }
  }
  return { rewritten, skipped, failed };
}

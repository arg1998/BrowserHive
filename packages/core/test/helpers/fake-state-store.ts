/** @module test/helpers/fake-state-store — an in-memory `TemplateStateStore` for service and route suites: states kept as JSON per slot, a scriptable key ring and failures. The envelope itself is covered by the real store's tests. */

import { createHash } from 'node:crypto';
import { templateKeyOf } from '../../src/domain/templates/envelope.ts';
import { AppError } from '../../src/kernel/errors/app-error.ts';
import type { TemplateStateFileRecord } from '../../src/ports/persistence/index.ts';
import type {
  StateFileInfo,
  StateSlot,
  TemplateKeyRing,
  TemplateState,
  TemplateStateStore,
} from '../../src/ports/template-state.ts';

/** The key the fake writes with by default. */
export const FAKE_TEMPLATE_KEY = templateKeyOf(new Uint8Array(32).fill(5));

/** One stored file. */
interface FakeFile {
  readonly text: string;
  readonly keyId: string;
}

/** In-memory state files keyed `<template> <slot>`. */
export class FakeTemplateStateStore implements TemplateStateStore {
  keys: TemplateKeyRing = { current: FAKE_TEMPLATE_KEY, previous: null };
  readonly files_ = new Map<string, FakeFile>();
  readonly metas = new Map<string, Readonly<Record<string, unknown>>>();
  /** When set, the next writes fail with it. */
  failWrite: Error | null = null;

  async write(
    templateId: string,
    slot: StateSlot,
    state: TemplateState,
  ): Promise<TemplateStateFileRecord> {
    if (this.failWrite !== null) throw this.failWrite;
    const key = this.keys.current;
    if (key === null) throw unreadable(templateId, slot, '');
    const text = JSON.stringify(state);
    this.files_.set(`${templateId} ${slot}`, { text, keyId: key.keyId });
    return {
      sizeBytes: text.length,
      sha256: createHash('sha256').update(text).digest('hex'),
      keyId: key.keyId,
    };
  }

  async read(templateId: string, slot: StateSlot): Promise<TemplateState> {
    const file = this.files_.get(`${templateId} ${slot}`);
    if (file === undefined) throw unreadable(templateId, slot, '');
    const known = [this.keys.current?.keyId, this.keys.previous?.keyId];
    if (!known.includes(file.keyId)) throw unreadable(templateId, slot, file.keyId);
    return JSON.parse(file.text) as TemplateState;
  }

  async remove(templateId: string, slot: StateSlot): Promise<void> {
    this.files_.delete(`${templateId} ${slot}`);
    this.metas.delete(`${templateId} ${slot}`);
  }

  async writeMeta(
    templateId: string,
    version: number,
    meta: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    this.metas.set(`${templateId} ${version}`, meta);
  }

  async files(templateId: string): Promise<readonly StateFileInfo[]> {
    return [...this.files_]
      .filter(([key]) => key.startsWith(`${templateId} `))
      .map(([key, file]) => {
        const raw = key.slice(templateId.length + 1);
        return {
          slot: raw === 'latest' ? 'latest' : Number(raw),
          keyId: file.keyId,
          sizeBytes: file.text.length,
        };
      });
  }

  async templatesWithFiles(): Promise<readonly string[]> {
    return [...new Set([...this.files_.keys()].map((k) => k.split(' ')[0] ?? ''))].sort();
  }

  /** Templates whose leftover `.tmp` files were removed, in order. */
  readonly temporariesRemoved: string[] = [];

  async removeTemporaries(templateId: string): Promise<number> {
    this.temporariesRemoved.push(templateId);
    return 0;
  }

  /** The stored state of a slot (tests). */
  stored(templateId: string, slot: StateSlot): TemplateState | null {
    const file = this.files_.get(`${templateId} ${slot}`);
    return file === undefined ? null : (JSON.parse(file.text) as TemplateState);
  }
}

function unreadable(
  templateId: string,
  slot: StateSlot,
  keyId: string,
): AppError<'TEMPLATE_VERSION_UNREADABLE'> {
  return new AppError(
    'TEMPLATE_VERSION_UNREADABLE',
    { template_id: templateId, version: slot, key_id: keyId },
    { publicMessage: `Version ${String(slot)} of template '${templateId}' cannot be read.` },
  );
}

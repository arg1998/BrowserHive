/** @module test/helpers/in-memory-template-repos — `templates` / `template_sites` in memory, with the SQLite repositories' name, version and cascade semantics. */

import { AppError } from '../../src/kernel/errors/app-error.ts';
import type {
  TemplatePatch,
  TemplateRecord,
  TemplateSiteHealthRecord,
  TemplateSiteRecord,
  TemplateStateFileRecord,
  TemplateVersionRecord,
} from '../../src/ports/persistence/records-templates.ts';
import type {
  ListAllOptions,
  TemplateRepository,
  TemplateSiteRepository,
  TemplateStateFacts,
  TemplateVersionRepository,
} from '../../src/ports/persistence/templates.ts';

/** SQLite's default (binary) collation: code-unit order, as `ORDER BY` compares TEXT. */
function binary(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `template_sites` in memory, keyed `<template_id> <site_id>`. */
export class InMemoryTemplateSiteRepository implements TemplateSiteRepository {
  readonly rows = new Map<string, TemplateSiteRecord>();

  async list(templateId: string): Promise<readonly TemplateSiteRecord[]> {
    return [...this.rows.values()]
      .filter((r) => r.templateId === templateId)
      .sort((a, b) => a.addedAt - b.addedAt || binary(a.siteId, b.siteId));
  }

  async listAll(_options?: ListAllOptions): Promise<readonly TemplateSiteRecord[]> {
    return [...this.rows.values()].sort(
      (a, b) =>
        binary(a.templateId, b.templateId) || a.addedAt - b.addedAt || binary(a.siteId, b.siteId),
    );
  }

  async upsert(record: TemplateSiteRecord): Promise<void> {
    const key = `${record.templateId} ${record.siteId}`;
    const prior = this.rows.get(key);
    this.rows.set(key, prior === undefined ? record : { ...record, addedAt: prior.addedAt });
  }

  async remove(templateId: string, siteId: string): Promise<boolean> {
    return this.rows.delete(`${templateId} ${siteId}`);
  }

  async setHealth(
    templateId: string,
    siteId: string,
    health: TemplateSiteHealthRecord,
  ): Promise<boolean> {
    const key = `${templateId} ${siteId}`;
    const row = this.rows.get(key);
    if (row === undefined) return false;
    this.rows.set(key, { ...row, health });
    return true;
  }

  /** `ON DELETE CASCADE` from `templates`. */
  dropTemplate(templateId: string): void {
    for (const [key, row] of this.rows) if (row.templateId === templateId) this.rows.delete(key);
  }
}

function nameTaken(name: string): AppError<'TEMPLATE_NAME_TAKEN'> {
  return new AppError(
    'TEMPLATE_NAME_TAKEN',
    { name },
    { publicMessage: `A session template named '${name}' already exists.` },
  );
}

/** `templates` in memory. */
export class InMemoryTemplateRepository implements TemplateRepository {
  readonly rows = new Map<string, TemplateRecord>();
  readonly #sites: InMemoryTemplateSiteRepository;
  readonly #versions: InMemoryTemplateVersionRepository | null;

  constructor(
    sites: InMemoryTemplateSiteRepository,
    versions: InMemoryTemplateVersionRepository | null = null,
  ) {
    this.#sites = sites;
    this.#versions = versions;
  }

  async listAll(_options?: ListAllOptions): Promise<readonly TemplateRecord[]> {
    return [...this.rows.values()].sort((a, b) => binary(a.name, b.name));
  }

  async get(templateId: string): Promise<TemplateRecord | null> {
    return this.rows.get(templateId) ?? null;
  }

  async getByName(name: string): Promise<TemplateRecord | null> {
    return [...this.rows.values()].find((r) => r.name === name) ?? null;
  }

  async insert(record: TemplateRecord): Promise<void> {
    if ((await this.getByName(record.name)) !== null) {
      throw nameTaken(record.name);
    }
    this.rows.set(record.templateId, { ...record, version: 1 });
  }

  async update(
    templateId: string,
    patch: TemplatePatch,
    ifVersion?: number,
  ): Promise<TemplateRecord> {
    const current = this.rows.get(templateId);
    if (current === undefined) {
      throw new AppError(
        'TEMPLATE_NOT_FOUND',
        { template: templateId },
        { publicMessage: `No session template '${templateId}'.` },
      );
    }
    if (ifVersion !== undefined && ifVersion !== current.version) {
      throw new AppError('CONFLICT', { current_version: current.version });
    }
    if (patch.name !== undefined && patch.name !== current.name) {
      if ((await this.getByName(patch.name)) !== null) {
        throw nameTaken(patch.name);
      }
    }
    const next: TemplateRecord = { ...current, ...patch, version: current.version + 1 };
    this.rows.set(templateId, next);
    return next;
  }

  async remove(templateId: string): Promise<boolean> {
    const removed = this.rows.delete(templateId);
    if (removed) {
      this.#sites.dropTemplate(templateId);
      this.#versions?.dropTemplate(templateId);
    }
    return removed;
  }

  async touchLastUsed(templateId: string, at: number): Promise<void> {
    const row = this.rows.get(templateId);
    if (row !== undefined) this.rows.set(templateId, { ...row, lastUsedAt: at });
  }

  async setStateFacts(templateId: string, facts: TemplateStateFacts): Promise<void> {
    const row = this.rows.get(templateId);
    if (row === undefined) return;
    this.rows.set(templateId, {
      ...row,
      ...(facts.checkpointAt !== undefined && { checkpointAt: facts.checkpointAt }),
      ...(facts.checkpointSizeBytes !== undefined && {
        checkpointSizeBytes: facts.checkpointSizeBytes,
      }),
      ...(facts.currentVersion !== undefined && { currentVersion: facts.currentVersion }),
    });
  }

  async count(): Promise<number> {
    return this.rows.size;
  }
}

/** `template_versions` in memory, keyed `<template_id> <version>`. */
export class InMemoryTemplateVersionRepository implements TemplateVersionRepository {
  readonly rows = new Map<string, TemplateVersionRecord>();

  async list(templateId: string): Promise<readonly TemplateVersionRecord[]> {
    return [...this.rows.values()]
      .filter((r) => r.templateId === templateId)
      .sort((a, b) => b.version - a.version);
  }

  async listAll(): Promise<readonly TemplateVersionRecord[]> {
    return [...this.rows.values()].sort(
      (a, b) => binary(a.templateId, b.templateId) || a.version - b.version,
    );
  }

  async get(templateId: string, version: number): Promise<TemplateVersionRecord | null> {
    return this.rows.get(`${templateId} ${version}`) ?? null;
  }

  async insert(record: TemplateVersionRecord): Promise<void> {
    const key = `${record.templateId} ${record.version}`;
    if (this.rows.has(key)) throw new AppError('CONFLICT', { current_version: record.version });
    this.rows.set(key, record);
  }

  async setPinned(
    templateId: string,
    version: number,
    pinned: boolean,
  ): Promise<TemplateVersionRecord | null> {
    const key = `${templateId} ${version}`;
    const row = this.rows.get(key);
    if (row === undefined) return null;
    const next = { ...row, pinned };
    this.rows.set(key, next);
    return next;
  }

  async updateFile(
    templateId: string,
    version: number,
    file: TemplateStateFileRecord,
  ): Promise<boolean> {
    const key = `${templateId} ${version}`;
    const row = this.rows.get(key);
    if (row === undefined) return false;
    this.rows.set(key, { ...row, ...file });
    return true;
  }

  async remove(templateId: string, version: number): Promise<boolean> {
    return this.rows.delete(`${templateId} ${version}`);
  }

  /** `ON DELETE CASCADE` from `templates`. */
  dropTemplate(templateId: string): void {
    for (const [key, row] of this.rows) if (row.templateId === templateId) this.rows.delete(key);
  }
}

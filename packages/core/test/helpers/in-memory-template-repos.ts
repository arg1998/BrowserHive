/** @module test/helpers/in-memory-template-repos — `templates` / `template_sites` in memory, with the SQLite repositories' name, version and cascade semantics. */

import { AppError } from '../../src/kernel/errors/app-error.ts';
import type {
  TemplatePatch,
  TemplateRecord,
  TemplateSiteHealthRecord,
  TemplateSiteRecord,
} from '../../src/ports/persistence/records-templates.ts';
import type {
  TemplateRepository,
  TemplateSiteRepository,
} from '../../src/ports/persistence/templates.ts';

/** `template_sites` in memory, keyed `<template_id> <site_id>`. */
export class InMemoryTemplateSiteRepository implements TemplateSiteRepository {
  readonly rows = new Map<string, TemplateSiteRecord>();

  async list(templateId: string): Promise<readonly TemplateSiteRecord[]> {
    return [...this.rows.values()]
      .filter((r) => r.templateId === templateId)
      .sort((a, b) => a.addedAt - b.addedAt || a.siteId.localeCompare(b.siteId));
  }

  async listAll(): Promise<readonly TemplateSiteRecord[]> {
    return [...this.rows.values()].sort(
      (a, b) =>
        a.templateId.localeCompare(b.templateId) ||
        a.addedAt - b.addedAt ||
        a.siteId.localeCompare(b.siteId),
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

/** `templates` in memory. */
export class InMemoryTemplateRepository implements TemplateRepository {
  readonly rows = new Map<string, TemplateRecord>();
  readonly #sites: InMemoryTemplateSiteRepository;

  constructor(sites: InMemoryTemplateSiteRepository) {
    this.#sites = sites;
  }

  async listAll(): Promise<readonly TemplateRecord[]> {
    return [...this.rows.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(templateId: string): Promise<TemplateRecord | null> {
    return this.rows.get(templateId) ?? null;
  }

  async getByName(name: string): Promise<TemplateRecord | null> {
    return [...this.rows.values()].find((r) => r.name === name) ?? null;
  }

  async insert(record: TemplateRecord): Promise<void> {
    if ((await this.getByName(record.name)) !== null) {
      throw new AppError('TEMPLATE_NAME_TAKEN', { name: record.name });
    }
    this.rows.set(record.templateId, { ...record, version: 1 });
  }

  async update(
    templateId: string,
    patch: TemplatePatch,
    ifVersion?: number,
  ): Promise<TemplateRecord> {
    const current = this.rows.get(templateId);
    if (current === undefined) throw new AppError('TEMPLATE_NOT_FOUND', { template: templateId });
    if (ifVersion !== undefined && ifVersion !== current.version) {
      throw new AppError('CONFLICT', { current_version: current.version });
    }
    if (patch.name !== undefined && patch.name !== current.name) {
      if ((await this.getByName(patch.name)) !== null) {
        throw new AppError('TEMPLATE_NAME_TAKEN', { name: patch.name });
      }
    }
    const next: TemplateRecord = { ...current, ...patch, version: current.version + 1 };
    this.rows.set(templateId, next);
    return next;
  }

  async remove(templateId: string): Promise<boolean> {
    const removed = this.rows.delete(templateId);
    if (removed) this.#sites.dropTemplate(templateId);
    return removed;
  }

  async touchLastUsed(templateId: string, at: number): Promise<void> {
    const row = this.rows.get(templateId);
    if (row !== undefined) this.rows.set(templateId, { ...row, lastUsedAt: at });
  }

  async count(): Promise<number> {
    return this.rows.size;
  }
}

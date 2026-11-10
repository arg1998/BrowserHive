/** @module ports/persistence/templates — repositories over `templates` and `template_sites` (spec 13 §2.6). */

import type {
  TemplatePatch,
  TemplateRecord,
  TemplateSiteHealthRecord,
  TemplateSiteRecord,
} from './records-templates.ts';

/**
 * Repository over `templates`. `listAll` replaces spec 13 §2.6's paged `list(query)`: the list
 * route sorts and filters by host state and live sessions, which only the host supervisor knows, so
 * paging happens in the template service over this (small, operator-made) set.
 */
export interface TemplateRepository {
  /** Every template, ordered by name. */
  listAll(): Promise<readonly TemplateRecord[]>;
  get(templateId: string): Promise<TemplateRecord | null>;
  getByName(name: string): Promise<TemplateRecord | null>;
  /** Inserts a new template with `version = 1`. @throws `TEMPLATE_NAME_TAKEN` when the name exists. */
  insert(record: TemplateRecord): Promise<void>;
  /**
   * Applies `patch`, bumps `version` and returns the stored row. With `ifVersion`, a stored version
   * that differs throws `CONFLICT` with `current_version`; a missing row throws `TEMPLATE_NOT_FOUND`;
   * a renamed row that collides throws `TEMPLATE_NAME_TAKEN`.
   */
  update(templateId: string, patch: TemplatePatch, ifVersion?: number): Promise<TemplateRecord>;
  /** Deletes the template (its sites, versions and probes cascade); true when a row went. */
  remove(templateId: string): Promise<boolean>;
  /** Stamps `last_used_at` (a virtual-session launch) without bumping `version`. */
  touchLastUsed(templateId: string, at: number): Promise<void>;
  count(): Promise<number>;
}

/** Repository over `template_sites`. */
export interface TemplateSiteRepository {
  /** The sites of one template, ordered by `added_at` then `site_id`. */
  list(templateId: string): Promise<readonly TemplateSiteRecord[]>;
  /** The sites of every template, in the same order per template. */
  listAll(): Promise<readonly TemplateSiteRecord[]>;
  /** Inserts or replaces one site (keyed by template and site). */
  upsert(record: TemplateSiteRecord): Promise<void>;
  /** Removes one site; true when a row went. */
  remove(templateId: string, siteId: string): Promise<boolean>;
  /** Replaces one site's health; false when the site does not exist. */
  setHealth(templateId: string, siteId: string, health: TemplateSiteHealthRecord): Promise<boolean>;
}

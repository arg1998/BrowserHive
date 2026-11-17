/** @module ports/persistence/templates — repositories over `templates` and `template_sites` (spec 13 §2.6). */

import type { TemplateProbeOutcome, TemplateProbeTrigger } from './enums.ts';
import type { Page, PageQuery, TimeWindow } from './queries.ts';
import type {
  TemplatePatch,
  TemplateProbeRecord,
  TemplateRecord,
  TemplateSiteHealthRecord,
  TemplateSiteRecord,
  TemplateStateFileRecord,
  TemplateVersionRecord,
} from './records-templates.ts';

/**
 * Repository over `templates`. `listAll` replaces spec 13 §2.6's paged `list(query)`: the list
 * route sorts and filters by host state and live sessions, which only the host supervisor knows, so
 * paging happens in the template service over this (small, operator-made) set.
 */
/** Options of the `listAll` reads. */
export interface ListAllOptions {
  /**
   * When given, a row that cannot be read (a corrupt `*_json` column, an unknown enum value) is
   * skipped and reported here instead of failing the whole list.
   */
  readonly onUnreadable?: (templateId: string, error: unknown) => void;
}

export interface TemplateRepository {
  /** Every template, ordered by name (binary collation). */
  listAll(options?: ListAllOptions): Promise<readonly TemplateRecord[]>;
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
  /**
   * Records BrowserHive's own state facts (the checkpoint's time and size, the newest version)
   * without bumping `version`, so a checkpoint never makes an operator's `If-Match` stale.
   */
  setStateFacts(templateId: string, facts: TemplateStateFacts): Promise<void>;
  count(): Promise<number>;
}

/** Columns {@link TemplateRepository.setStateFacts} writes; absent keys are unchanged. */
export interface TemplateStateFacts {
  readonly checkpointAt?: number | null;
  readonly checkpointSizeBytes?: number | null;
  readonly currentVersion?: number | null;
}

/** Repository over `template_sites`. */
export interface TemplateSiteRepository {
  /** The sites of one template, ordered by `added_at` then `site_id`. */
  list(templateId: string): Promise<readonly TemplateSiteRecord[]>;
  /** The sites of every template, in the same order per template. */
  listAll(options?: ListAllOptions): Promise<readonly TemplateSiteRecord[]>;
  /** Inserts or replaces one site (keyed by template and site). */
  upsert(record: TemplateSiteRecord): Promise<void>;
  /** Removes one site; true when a row went. */
  remove(templateId: string, siteId: string): Promise<boolean>;
  /** Replaces one site's health; false when the site does not exist. */
  setHealth(templateId: string, siteId: string, health: TemplateSiteHealthRecord): Promise<boolean>;
}

/** Repository over `template_versions` (spec 13 §2.6, §3.9); retention is decided in the domain. */
export interface TemplateVersionRepository {
  /** The versions of one template, newest first. */
  list(templateId: string): Promise<readonly TemplateVersionRecord[]>;
  /** Every version of every template (boot reconciliation, `rekey`), by template then version. */
  listAll(): Promise<readonly TemplateVersionRecord[]>;
  get(templateId: string, version: number): Promise<TemplateVersionRecord | null>;
  /** Inserts a version; a taken `(template_id, version)` throws `CONFLICT`. */
  insert(record: TemplateVersionRecord): Promise<void>;
  /** Pins or unpins; `null` when the version does not exist. */
  setPinned(
    templateId: string,
    version: number,
    pinned: boolean,
  ): Promise<TemplateVersionRecord | null>;
  /** The file was re-encrypted (`rekey`); false when the version does not exist. */
  updateFile(templateId: string, version: number, file: TemplateStateFileRecord): Promise<boolean>;
  /** Deletes one version row; true when a row went. */
  remove(templateId: string, version: number): Promise<boolean>;
}

/** Filters of {@link TemplateProbeRepository.list}: newest first. */
export interface TemplateProbeQuery extends Pick<PageQuery, 'limit' | 'cursor'>, TimeWindow {
  readonly siteId?: string;
  readonly outcomes?: readonly TemplateProbeOutcome[];
  readonly triggers?: readonly TemplateProbeTrigger[];
}

/** Repository over `template_probes` (spec 13 §2.6, §8). */
export interface TemplateProbeRepository {
  /** Inserts one probe; returns its `seq`. */
  insert(record: TemplateProbeRecord): Promise<number>;
  /** One template's probes, newest first (`at`, then `seq`). */
  list(templateId: string, query: TemplateProbeQuery): Promise<Page<TemplateProbeRecord>>;
  /** Probes of every template since `since` (digests), oldest first. */
  since(since: number, until: number): Promise<readonly TemplateProbeRecord[]>;
  /** Deletes probes older than `before`; returns the number deleted. */
  prune(before: number): Promise<number>;
}

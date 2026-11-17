/** @module app/site-packs/registry-types — the registry's collaborators and its immutable snapshot (spec 13 §9.6): per pack id the approved content (from its source or BrowserHive's copy, D-67), the local file's state, the offer for first use, the pending candidates and the templates using it; per registrable domain the owning pack. */

import type { SitePackV1 } from '@browserhive/contracts/site-packs';
import type { Clock } from '../../ports/clock.ts';
import type { DegradationReporter } from '../../ports/degradation-reporter.ts';
import type { EventPublisher } from '../../ports/event-bus.ts';
import type { IdGenerator } from '../../ports/id-generator.ts';
import type { Logger } from '../../ports/logger.ts';
import type { Repositories, UnitOfWork } from '../../ports/persistence/index.ts';
import type {
  SitePackChangeRecord,
  SitePackSourceId,
  SitePackStateRecord,
} from '../../ports/persistence/site-packs.ts';
import type { LocalPackWriter, SitePackCache } from '../../ports/site-pack-files.ts';
import type {
  EffectivePack,
  SitePackSource,
  SkippedPackVersion,
  SourceCatalog,
  SourcePackVersion,
} from '../../ports/site-packs.ts';
import type { DomainEvents } from '../events/catalog.ts';

/** The bundled snapshot of this release. */
export interface BundledSource extends SitePackSource {
  /** The provenance "Bundled with BrowserHive <release>". */
  readonly release: string;
  /** `built_at` of the build's index (`null` from source). */
  readonly builtAt: number | null;
}

/** The local folder (`sitePacksDir`). */
export interface LocalSource extends SitePackSource {
  readonly dir: string;
}

/** Collaborators of `SitePackRegistry`. */
export interface SitePackRegistryDeps {
  /** `sitePacks` (spec 08 §5.9): `false` = nothing applies, every lookup answers `null`. */
  readonly enabled: boolean;
  readonly bundled: BundledSource;
  readonly local: LocalSource;
  readonly cache: SitePackCache;
  readonly localWriter: LocalPackWriter;
  readonly uow: UnitOfWork;
  readonly repos: Pick<
    Repositories,
    'sitePackState' | 'sitePackChanges' | 'siteGuardHits' | 'templateSites' | 'operatorActions'
  >;
  /** This binary's version (`min_client`/`max_client` of cached copies). */
  readonly binaryVersion: string;
  readonly ids: Pick<IdGenerator, 'eventId'>;
  readonly clock: Clock;
  readonly logger: Logger;
  /** The `site-packs` topic and the update notification. */
  readonly bus?: EventPublisher<DomainEvents>;
  /** `SITE_PACKS_STATE_CORRUPT` for unreadable rows (review #83 C-M5). */
  readonly degradations?: DegradationReporter;
  /** A template whose sites use a pack whose content in force changed (`template.changed`). */
  readonly templateChanged?: (templateId: string) => void;
}

/** A local file and what of it applies (spec 13 §10.5). */
export interface LocalEntry {
  readonly path: string;
  /** The file's current, valid content; `null` when the file is missing or invalid. */
  readonly current: SourcePackVersion | null;
  /** Why the current file was refused. */
  readonly problem: SkippedPackVersion | null;
  /** The approved local content in force (the file when its hash matches, else BrowserHive's copy). */
  readonly approved: SourcePackVersion | null;
  readonly state: 'approved' | 'changed' | 'not_approved';
}

/** One pack id in the snapshot. */
export interface PackEntry {
  readonly packId: string;
  readonly state: SitePackStateRecord | null;
  /** The approved non-local version's content (source bytes or the cached copy). */
  readonly approved: SourcePackVersion | null;
  readonly local: LocalEntry | null;
  /** What adding a site would approve (bundled, only while nothing is approved). */
  readonly offer: SourcePackVersion | null;
  /** The content in force; `null` when disabled, overlapping, un-approved or `sitePacks=false`. */
  readonly effective: EffectivePack | null;
  /** What the views describe: the content in force, else the approved, offered or local one. */
  readonly display: SitePackV1 | null;
  /** Pending candidates (`downloaded`), newest version first. */
  readonly pending: readonly SitePackChangeRecord[];
  readonly usedBy: readonly string[];
  readonly skipped: SkippedPackVersion | null;
  /** The first domain this pack's content claims that another pack covers (`domain_overlap`). */
  readonly overlap: { readonly domain: string; readonly owner: string } | null;
}

/** What one load found per source. */
export interface SourceStats {
  readonly source: SitePackSourceId;
  readonly loaded: number;
  readonly skipped: readonly SkippedPackVersion[];
  readonly signedLayouts: number;
}

/** The registry's immutable state between swaps. */
export interface RegistrySnapshot {
  readonly generation: number;
  readonly packs: ReadonlyMap<string, PackEntry>;
  /** Registrable domain → the pack that owns it (in force or on offer). */
  readonly byDomain: ReadonlyMap<string, string>;
  readonly bundled: SourceCatalog;
  readonly local: SourceCatalog;
  /** Skips found while building (missing cached copies, overlaps). */
  readonly resolveSkips: readonly (SkippedPackVersion & { readonly source: SitePackSourceId })[];
  readonly loadedAt: number | null;
}

/** An empty snapshot (before the first load). */
export function emptySnapshot(): RegistrySnapshot {
  const empty = (source: SitePackSourceId): SourceCatalog => ({
    source,
    packs: [],
    skipped: [],
    signedLayouts: 0,
  });
  return {
    generation: 0,
    packs: new Map(),
    byDomain: new Map(),
    bundled: empty('bundled'),
    local: empty('local'),
    resolveSkips: [],
    loadedAt: null,
  };
}

/** One item of `pending()`: a candidate of a followed pack, or a local file waiting for approval. */
export type PendingUpdate =
  | {
      readonly kind: 'candidate';
      readonly packId: string;
      readonly title: string;
      readonly fromVersion: number | null;
      readonly toVersion: number;
      readonly sha256: string;
      readonly source: SitePackSourceId;
    }
  | {
      readonly kind: 'local';
      readonly packId: string;
      readonly title: string;
      readonly state: 'changed' | 'not_approved';
      readonly sha256: string;
      readonly version: number;
    };

/** The result of approving a pack for a template site. */
export interface SiteApproval {
  readonly packId: string;
  /** The version in force for the site (the local file's when a local override applies). */
  readonly version: number;
  readonly sha256: string;
}

/**
 * A first-use approval prepared outside any transaction (cache copy done, conflicts checked) and
 * written in the caller's: a template's or site's rows commit with the approval or not at all
 * (review #83 C-L9).
 */
export interface PreparedApproval extends SiteApproval {
  /** `true` when this approves a version; `false` when an approval already existed. */
  readonly approves: boolean;
  /** The approval's rows (`site_pack_state`, a change row, `site_pack.approve`); idempotent. */
  write(repos: Repositories): Promise<void>;
}

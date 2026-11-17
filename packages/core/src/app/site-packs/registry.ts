/** @module app/site-packs/registry — `SitePackRegistry` (spec 13 §9.6): loads the bundled and local sources, keeps an immutable snapshot swapped atomically (a failed source load keeps that source's previous catalog, D-22), answers the synchronous `SitePackLookup` every enforcement point uses, and runs the approval model (first use, Apply, Reject, Revert, Pin, Follow, approve-local, enable) through `registry-actions.ts`. */

import type {
  SiteGuardHitsPage,
  SiteGuardHitsQuery,
  SitePackChangesPage,
  SitePackChangesQuery,
  SitePackDetailResponse,
  SitePackDiffQuery,
  SitePackDiffResponse,
  SitePackImportResponse,
  SitePackRegistryStats,
  SitePackRegistryStatus,
  SitePacksQuery,
  SitePacksResponse,
  SitePackView,
  TemplateSitePack,
} from '@browserhive/contracts/http';
import { registrableDomain } from '../../kernel/url.ts';
import type { Logger } from '../../ports/logger.ts';
import type { EffectivePack, SitePackLookup, SourceCatalog } from '../../ports/site-packs.ts';
import * as actions from './registry-actions.ts';
import { assembleSnapshot, resolvePacks, withUsage } from './registry-build.ts';
import { packNotFound } from './registry-errors.ts';
import {
  diffOf,
  listChanges,
  listGuardHits,
  listPacks,
  packDetail,
  pendingOf,
} from './registry-reads.ts';
import { loadCatalog, sourceStats } from './registry-sync.ts';
import {
  emptySnapshot,
  type PackEntry,
  type PendingUpdate,
  type RegistrySnapshot,
  type SiteApproval,
  type SitePackRegistryDeps,
  type SourceStats,
} from './registry-types.ts';
import { toRegistryStats, toRegistryStatus, toSitePackView, toTemplateSitePack } from './views.ts';

/** The site-pack registry. */
export class SitePackRegistry implements SitePackLookup {
  readonly #deps: SitePackRegistryDeps;
  readonly #log: Logger;
  #snapshot: RegistrySnapshot = emptySnapshot();
  #stats: readonly SourceStats[] = [];
  #templateChanged: ((templateId: string) => void) | undefined;
  /** Reloads and decisions run one at a time. */
  #tail: Promise<unknown> = Promise.resolve();

  constructor(deps: SitePackRegistryDeps) {
    this.#deps = deps;
    this.#log = deps.logger.child({ module: 'site-packs' });
    this.#templateChanged = deps.templateChanged;
  }

  /** Sets the `template.changed` hook (the template service is built after the registry). */
  attachTemplateChanged(fn: (templateId: string) => void): void {
    this.#templateChanged = fn;
  }

  /** `sitePacks`. */
  get enabled(): boolean {
    return this.#deps.enabled;
  }

  // --- SitePackLookup -------------------------------------------------------------------------

  get generation(): number {
    return this.#snapshot.generation;
  }

  effectiveFor(hostOrDomain: string): EffectivePack | null {
    const domain = registrableDomain(hostOrDomain);
    if (domain === '') return null;
    const owner = this.#snapshot.byDomain.get(domain);
    return owner === undefined ? null : (this.#snapshot.packs.get(owner)?.effective ?? null);
  }

  effectiveById(packId: string): EffectivePack | null {
    return this.#snapshot.packs.get(packId)?.effective ?? null;
  }

  // --- template integration -------------------------------------------------------------------

  /** The pack that owns a site (registrable domain): in force or on offer; `null` when none or off. */
  packIdFor(siteId: string): string | null {
    if (!this.#deps.enabled) return null;
    const owner = this.#snapshot.byDomain.get(registrableDomain(siteId) || siteId);
    return owner ?? null;
  }

  /** The pack in force for a template site, as the template views show it. */
  sitePackOf(packId: string | null): TemplateSitePack | null {
    if (packId === null) return null;
    const effective = this.effectiveById(packId);
    if (effective === null) return null;
    return toTemplateSitePack(effective, this.humanOnly(packId), true);
  }

  /** The identity provider whose sign-in a pack's site uses (spec 13 §8.6), else `null`. */
  providerOf(packId: string | null): string | null {
    if (packId === null) return null;
    return this.effectiveById(packId)?.pack.identity_provider ?? null;
  }

  /** `sign_in.human_only` of the pack in force, through its identity provider's pack. */
  humanOnly(packId: string | null): boolean {
    if (packId === null) return false;
    const pack = this.effectiveById(packId)?.pack;
    if (pack === undefined) return false;
    if (pack.sign_in !== undefined) return pack.sign_in.human_only;
    const provider = pack.identity_provider;
    return provider === undefined
      ? false
      : this.effectiveFor(provider)?.pack.sign_in?.human_only === true;
  }

  /**
   * Approves the pack a new template site uses (spec 13 §9.6 "First use", D-67): the version
   * already approved, else the offer. `sha256` is what the operator reviewed; a mismatch is
   * `CONFLICT`. `null` when no pack covers the site (it stays generic) or `sitePacks=false`.
   */
  approveSite(
    siteId: string,
    sha256: string | undefined,
    by: string,
  ): Promise<SiteApproval | null> {
    const packId = this.packIdFor(siteId);
    if (packId === null) {
      return sha256 === undefined
        ? Promise.resolve(null)
        : Promise.reject(actions.noPackToApprove(siteId));
    }
    return this.approveOnFirstUse(packId, sha256, by);
  }

  /** {@link approveSite} by pack id. @throws `SITE_PACK_NOT_FOUND`, `CONFLICT`. */
  approveOnFirstUse(
    packId: string,
    sha256: string | undefined,
    by: string,
  ): Promise<SiteApproval | null> {
    if (!this.#deps.enabled) return Promise.resolve(null);
    return this.#serial(() => actions.approveFirstUse(this.#core(), packId, sha256, by));
  }

  // --- reads ----------------------------------------------------------------------------------

  /** Every pack with the registry's status (`GET /site-packs`). */
  list(query: SitePacksQuery = { source: undefined }): SitePacksResponse {
    return listPacks(this.#snapshot, query, this.#readFacts());
  }

  /** One pack's view, or `null`. */
  get(packId: string): SitePackView | null {
    const entry = this.#snapshot.packs.get(packId);
    return entry === undefined ? null : this.#view(entry);
  }

  /** `GET /site-packs/{pack_id}`. @throws `SITE_PACK_NOT_FOUND`. */
  detail(packId: string): SitePackDetailResponse {
    return packDetail(this.#entry(packId), this.#readFacts());
  }

  /** `GET /site-packs/{pack_id}/diff`. @throws `SITE_PACK_NOT_FOUND`, `CONFLICT`. */
  async diff(packId: string, query: SitePackDiffQuery): Promise<SitePackDiffResponse> {
    return diffOf(this.#entry(packId), this.#snapshot, query, this.#deps);
  }

  /** Pending candidates of followed, unpinned packs and local files needing approval. */
  pending(): readonly PendingUpdate[] {
    return pendingOf(this.#snapshot);
  }

  /** The registry's status. */
  status(): SitePackRegistryStatus {
    return toRegistryStatus(this.#snapshot, this.#readFacts().status);
  }

  /** What the last load found per source. */
  stats(): SitePackRegistryStats {
    return toRegistryStats(this.#stats, this.#snapshot.loadedAt ?? 0);
  }

  /** `GET /site-packs/changes`. */
  changes(query: SitePackChangesQuery): Promise<SitePackChangesPage> {
    return listChanges(this.#deps.repos.sitePackChanges, query, this.#deps.clock.now());
  }

  /** `GET /site-packs/guard-hits`. */
  guardHits(query: SiteGuardHitsQuery): Promise<SiteGuardHitsPage> {
    return listGuardHits(this.#deps.repos.siteGuardHits, query, this.#deps.clock.now());
  }

  // --- loading --------------------------------------------------------------------------------

  /**
   * Reads both sources and swaps the snapshot (spec 13 §9.6). A source that fails to load keeps its
   * previous catalog. `by` (an operator's reload) records `site_pack.reload`.
   */
  reload(by?: string): Promise<SitePackRegistryStats> {
    return this.#serial(async () => {
      const signal = AbortSignal.timeout(30_000);
      const bundled = await loadCatalog(
        this.#deps.bundled,
        this.#snapshot.bundled,
        signal,
        this.#log,
      );
      const local = await loadCatalog(this.#deps.local, this.#snapshot.local, signal, this.#log);
      const previous = this.#snapshot;
      await this.#rebuild(bundled, local);
      const now = this.#deps.clock.now();
      this.#stats = [bundled, local].map(sourceStats);
      await actions.recordLocalOverrides(this.#core(), previous, this.#snapshot);
      if (by !== undefined) {
        await actions.auditReload(this.#core(), by, this.#stats);
      }
      for (const packId of this.#snapshot.packs.keys()) this.#publishPack(packId);
      this.#publishStatus();
      this.#log.info('site packs loaded', {
        bundled: bundled.packs.length,
        local: local.packs.length,
        skipped: bundled.skipped.length + local.skipped.length,
        generation: this.#snapshot.generation,
      });
      return toRegistryStats(this.#stats, now);
    });
  }

  /**
   * Re-reads which templates use each pack (`used_by`, automatic Follow) after template or site
   * changes; the content in force is unchanged.
   */
  refreshUsage(): Promise<void> {
    return this.#serial(async () => {
      const next = withUsage(this.#snapshot, await this.#deps.repos.templateSites.listAll());
      if (next.changed.length === 0) return;
      this.#snapshot = next.snapshot;
      for (const packId of next.changed) this.#publishPack(packId);
      this.#publishStatus();
    });
  }

  // --- decisions (spec 13 §10.5, §10.6) ---------------------------------------------------------

  /** Apply a pending version. @throws `SITE_PACK_NOT_FOUND`, `SITE_PACK_UPDATE_NOT_PENDING`. */
  apply(packId: string, version: number, by: string): Promise<SitePackView> {
    return this.#act(packId, () => actions.applyVersion(this.#core(), packId, version, by));
  }

  /** Reject a pending version. @throws `SITE_PACK_NOT_FOUND`, `SITE_PACK_UPDATE_NOT_PENDING`. */
  reject(packId: string, version: number, by: string): Promise<SitePackView> {
    return this.#act(packId, () => actions.rejectVersion(this.#core(), packId, version, by));
  }

  /** Restore the previous approved version. @throws `SITE_PACK_NOT_FOUND`, `CONFLICT`. */
  revert(packId: string, by: string): Promise<SitePackView> {
    return this.#act(packId, () => actions.revertVersion(this.#core(), packId, by));
  }

  /** Pin the approved version, or unpin (`null`). @throws `VALIDATION_FAILED`. */
  pin(packId: string, version: number | null, by: string): Promise<SitePackView> {
    return this.#act(packId, () => actions.pinVersion(this.#core(), packId, version, by));
  }

  /** Follow updates on, off, or automatically (`null`). */
  setFollow(packId: string, follow: boolean | null, by: string): Promise<SitePackView> {
    return this.#act(packId, () => actions.setFollow(this.#core(), packId, follow, by));
  }

  /** Approve the local file's content by the hash reviewed. @throws `CONFLICT`, `SITE_PACK_INVALID`. */
  approveLocal(packId: string, sha256: string, by: string): Promise<SitePackView> {
    return this.#act(packId, () => actions.approveLocal(this.#core(), packId, sha256, by));
  }

  /** Enable or disable a pack. */
  setEnabled(packId: string, enabled: boolean, by: string): Promise<SitePackView> {
    return this.#act(packId, () => actions.setEnabled(this.#core(), packId, enabled, by));
  }

  /**
   * `POST /site-packs/import` with one unsigned pack: stored in `sitePacksDir` as `<id>.json`, then
   * approved like any local file. @throws `SITE_PACK_INVALID`.
   */
  async importPack(raw: unknown, by: string): Promise<SitePackImportResponse> {
    const written = await this.#serial(() => actions.importPack(this.#core(), raw, by));
    await this.reload();
    const view = this.get(written.packId);
    return {
      imported: [
        {
          pack_id: written.packId,
          version: written.version,
          state: view?.local?.state ?? 'not_approved',
          sha256: written.sha256,
        },
      ],
    };
  }

  // --- internals ------------------------------------------------------------------------------

  #core(): actions.RegistryCore {
    return {
      deps: this.#deps,
      snapshot: () => this.#snapshot,
      entry: (packId) => this.#entry(packId),
      refresh: () => this.#rebuild(this.#snapshot.bundled, this.#snapshot.local),
      log: this.#log,
    };
  }

  #entry(packId: string): PackEntry {
    const entry = this.#snapshot.packs.get(packId);
    if (entry === undefined) throw packNotFound(packId);
    return entry;
  }

  #view(entry: PackEntry): SitePackView {
    const sizes = new Map(this.#snapshot.bundled.packs.map((p) => [p.sha256, p.size]));
    return toSitePackView(entry, this.#deps.bundled.release, (sha) => sizes.get(sha) ?? null);
  }

  #readFacts() {
    return {
      view: (entry: PackEntry) => this.#view(entry),
      status: {
        enabled: this.#deps.enabled,
        release: this.#deps.bundled.release,
        builtAt: this.#deps.bundled.builtAt,
        localDir: this.#deps.local.dir,
      },
      now: this.#deps.clock.now(),
    };
  }

  async #act(packId: string, run: () => Promise<void>): Promise<SitePackView> {
    await this.#serial(async () => {
      this.#entry(packId);
      await run();
      this.#publishPack(packId);
      this.#publishStatus();
    });
    const entry = this.#entry(packId);
    for (const templateId of entry.usedBy) this.#templateChanged?.(templateId);
    return this.#view(entry);
  }

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(fn, fn);
    this.#tail = run.catch(() => undefined);
    return run;
  }

  /** Re-derives the snapshot from the catalogs and the stored state, then swaps it. */
  async #rebuild(bundled: SourceCatalog, local: SourceCatalog): Promise<void> {
    const { repos, cache, binaryVersion } = this.#deps;
    const input = { bundled, local, localDir: this.#deps.local.dir, cache, binaryVersion };
    const resolved = await resolvePacks({ ...input, states: await repos.sitePackState.list() });
    const fresh = await actions.syncCandidates(this.#core(), resolved);
    this.#snapshot = assembleSnapshot(resolved, {
      enabled: this.#deps.enabled,
      generation: this.#snapshot.generation + 1,
      bundled,
      local,
      pending: await repos.sitePackChanges.listPending(),
      sites: await repos.templateSites.listAll(),
      loadedAt: this.#deps.clock.now(),
    });
    for (const event of fresh) this.#deps.bus?.publish('site_pack.pending', event);
  }

  #publishPack(packId: string): void {
    const entry = this.#snapshot.packs.get(packId);
    if (entry === undefined) return;
    this.#deps.bus?.publish('site_pack.changed', {
      type: 'site_pack.changed',
      view: this.#view(entry),
    });
  }

  #publishStatus(): void {
    this.#deps.bus?.publish('site_pack.status', {
      type: 'site_pack.status',
      status: this.status(),
      updates: actions.updatesFact(this.#snapshot, this.#deps.clock.now()),
    });
  }
}

/** @module app/site-packs/client/registry-client — `SitePackRegistryClient` (spec 13 §10.3–§10.6, D-55): the automatic check of the signed index only (5 min after start, then every 24 h ± 2 h, backing off after failures), **Check now**, verification with the stored rollback floors, the held last good index, the candidates it lists, revocations and auto-update; downloads, imports and export are in `client-ops.ts`. With `sitePacksUpdateCheck=false`, or while the build pins no registry keys, it makes no request at all. */

import type {
  SitePackCheckOff,
  SitePackCheckResponse,
  SitePackDownloadAllResponse,
  SitePackDownloadResponse,
  SitePackExportResponse,
  SitePackImportResponse,
} from '@browserhive/contracts/http';
import {
  REGISTRY_INDEX_MAX_BYTES,
  REGISTRY_KEYS_MAX_BYTES,
  REGISTRY_SIG_MAX_BYTES,
} from '@browserhive/contracts/site-packs';
import type { z } from 'zod';
import { serializeError } from '../../../kernel/errors/serialize-error.ts';
import type { Logger } from '../../../ports/logger.ts';
import type { SitePackProvenanceRecord } from '../../../ports/persistence/site-packs.ts';
import type { HeldLayoutFile, RegistryFetchResult } from '../../../ports/site-pack-registry.ts';
import type { SkippedPackVersion } from '../../../ports/site-packs.ts';
import type { HeldIndex, RemoteFacts, RemoteStatusPart } from '../registry-types.ts';
import { type Acceptance, acceptLayout, floorsAfter, type LayoutFiles } from './accept.ts';
import * as ops from './client-ops.ts';
import {
  type ClientRecord,
  EMPTY_CLIENT,
  type RegistryFloorsRecord,
  readClient,
  readFloors,
  writeClient,
  writeFloors,
} from './client-state.ts';
import type { HeldState, RegistryClientDeps } from './client-types.ts';
import { loadHeld, readSnapshot, type SnapshotFacts } from './held.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** The first automatic check after start (spec 13 §10.4). */
export const FIRST_CHECK_MS = 5 * MINUTE;
/** The automatic check's base interval; ± {@link JITTER_MS}. */
export const CHECK_INTERVAL_MS = 24 * HOUR;
/** Consecutive failures that record `SITE_PACKS_FETCH_FAILED`. */
export const FAILURES_DEGRADED = 3;
/** A registry `Date` this far from the local clock is reported (`clock_skew_ms`). */
const SKEW_REPORTED_MS = 5 * MINUTE;
/** … and this far, the stale message says to check the system clock (spec 13 §10.3 step 4). */
const SKEW_CLOCK_HINT_MS = HOUR;

const STALE = 'SITE_PACKS_STALE';
const FETCH_FAILED = 'SITE_PACKS_FETCH_FAILED';

/** The files of a check and their caps, `keys.json` first. */
const CHECK_FILES: readonly { readonly file: HeldLayoutFile; readonly max: number }[] = [
  { file: 'keys.json', max: REGISTRY_KEYS_MAX_BYTES },
  { file: 'keys.json.sig', max: REGISTRY_SIG_MAX_BYTES },
  { file: 'index.json', max: REGISTRY_INDEX_MAX_BYTES },
  { file: 'index.json.sig', max: REGISTRY_SIG_MAX_BYTES },
];

const FIELD: Readonly<Record<HeldLayoutFile, keyof LayoutFiles>> = {
  'keys.json': 'keys',
  'keys.json.sig': 'keysSig',
  'index.json': 'index',
  'index.json.sig': 'indexSig',
};

/** A failed check's reason as stored (`last_error`). */
interface CheckError {
  readonly code: string;
  readonly message: string;
}

/** The site-pack registry client. */
export class SitePackRegistryClient implements RemoteFacts {
  readonly #deps: RegistryClientDeps;
  readonly #log: Logger;
  #record: ClientRecord = EMPTY_CLIENT;
  #floors: RegistryFloorsRecord = { keysVersion: null, indexVersion: null };
  #held: HeldState | null = null;
  #snapshot: SnapshotFacts | null = null;
  #layoutSkips: SkippedPackVersion[] = [];
  #nextAt: number | null = null;
  #cancel: (() => void) | null = null;
  #stopped = false;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(deps: RegistryClientDeps) {
    this.#deps = deps;
    this.#log = deps.logger.child({ module: 'site-pack-registry' });
  }

  /** Why no request is made, or `null` when the client may reach the registry. */
  get checkOff(): z.infer<typeof SitePackCheckOff> | null {
    if (!this.#deps.packsEnabled) return 'packs_off';
    if (!this.#deps.updateCheck) return 'update_check_off';
    if (this.#deps.verifier.trustsNothing) return 'no_trust_root';
    return null;
  }

  /**
   * Reads the held state back, seeds the floors from the release snapshot on a fresh install,
   * attaches to the registry (which rebuilds with the held index's listings), imports the signed
   * layouts of the local folder and schedules the first automatic check.
   */
  async start(): Promise<void> {
    const { deps } = this;
    this.#record = await readClient(deps.meta);
    this.#floors = await readFloors(deps.meta);
    this.#held = await loadHeld(deps.held, this.#record, deps.sha256);
    if (deps.snapshot !== undefined) await this.#seedFromSnapshot();
    deps.registry.attachRemote(this);
    if (deps.packsEnabled) {
      await deps.registry.mutate(async (core) => {
        if (this.#held !== null) await ops.recordCandidates(core, this.#held.index);
      });
      await ops.applyRevocations(this.#ctx());
      await this.importLocalLayouts(deps.registry.snapshotNow().local.layouts ?? []);
    }
    this.#reportStale();
    if (this.checkOff === null) this.#scheduleNext(deps.firstCheckMs ?? FIRST_CHECK_MS);
  }

  /** Cancels the automatic check. */
  stop(): void {
    this.#stopped = true;
    this.#cancel?.();
    this.#cancel = null;
    this.#nextAt = null;
  }

  get deps(): RegistryClientDeps {
    return this.#deps;
  }

  // --- RemoteFacts ----------------------------------------------------------------------------

  held(): HeldIndex | null {
    const held = this.#held;
    if (held === null) return null;
    return {
      index: held.index,
      signedBy: held.signedBy,
      origin: held.origin,
      originName: held.originName,
      stale: this.#deps.clock.now() >= Date.parse(held.index.expires),
    };
  }

  provenance(
    source: 'remote' | 'import',
    _packId: string,
    _sha256: string,
  ): SitePackProvenanceRecord | null {
    const held = this.#held;
    if (source === 'import') {
      const name = held !== null && held.origin !== 'registry' ? held.originName : null;
      return { kind: 'import', file: name ?? 'a signed export' };
    }
    if (held === null) return null;
    return { kind: 'remote', keyId: held.signedBy, indexVersion: held.index.version };
  }

  status(): RemoteStatusPart {
    const held = this.#held;
    const record = this.#record;
    const snapshot = this.#snapshot;
    return {
      update_check: this.#deps.updateCheck,
      check_off: this.checkOff,
      trusts_registry: !this.#deps.verifier.trustsNothing,
      auto_update: this.#deps.autoUpdate,
      url: this.#deps.fetcher.url,
      last_check_at: record.last_check_at,
      last_ok_at: record.last_ok_at,
      last_outcome: record.last_outcome,
      last_error: record.last_error,
      failures: record.failures,
      next_check_at: this.#nextAt,
      index_version: held?.index.version ?? null,
      index_issued_at: held === null ? null : Date.parse(held.index.issued_at),
      index_expires_at: held === null ? null : Date.parse(held.index.expires),
      index_signed_by: held?.signedBy ?? null,
      index_packs: held?.index.packs.length ?? 0,
      index_origin: held?.origin ?? null,
      stale: this.held()?.stale ?? false,
      ...(record.clock_skew_ms !== undefined && { clock_skew_ms: record.clock_skew_ms }),
      keys_version: this.#floors.keysVersion,
      snapshot:
        snapshot === null
          ? null
          : {
              index_version: snapshot.indexVersion,
              verified: snapshot.verified,
              detail: snapshot.detail,
            },
      layoutSkips: this.#layoutSkips,
    };
  }

  async importLocalLayouts(paths: readonly string[]): Promise<void> {
    this.#layoutSkips = await this.#serial(() => ops.importLocalLayouts(this.#ctx(), paths));
  }

  // --- the check ------------------------------------------------------------------------------

  /** **Check now** (`POST /site-packs/check`), or the automatic check (`by` absent). Never throws for a failed fetch. */
  check(by?: string): Promise<SitePackCheckResponse> {
    return this.#serial(() => this.#check(by));
  }

  async #check(by: string | undefined): Promise<SitePackCheckResponse> {
    const { deps } = this;
    const now = deps.clock.now();
    const off = this.checkOff;
    if (off !== null) {
      return { outcome: 'disabled', checked_at: now, available: 0, status: this.#status() };
    }
    const fetched = await this.#fetchLayout();
    let outcome: SitePackCheckResponse['outcome'];
    let error: CheckError | undefined;
    let available = 0;
    let stale = false;
    if ('error' in fetched) {
      outcome = 'failed';
      error = fetched.error;
    } else {
      const acceptance = acceptLayout({
        verifier: deps.verifier,
        files: fetched.files,
        heldIndexSha256: this.#held === null ? null : deps.sha256(this.#held.files.index),
        sha256: deps.sha256,
        floors: this.#floors,
        now,
      });
      const applied = await this.#acceptFetched(acceptance, fetched.files);
      outcome = applied.outcome;
      error = applied.error;
      stale = applied.stale;
      this.#noteSkew(fetched.date, now);
    }
    if (outcome !== 'failed') {
      const synced = await ops.afterAccept(this.#ctx(), { autoUpdate: deps.autoUpdate });
      available = synced.available;
    }
    await this.#finish(now, outcome, error, by);
    deps.bus?.publish('site_pack.checked', {
      type: 'site_pack.checked',
      outcome: stale ? 'stale' : outcome === 'disabled' ? 'failed' : outcome,
      index_version: this.#held?.index.version ?? null,
    });
    return {
      outcome,
      checked_at: now,
      available,
      ...(error !== undefined && { error }),
      status: this.#status(),
    };
  }

  /** The four files, a `304` answered with the held bytes. */
  async #fetchLayout(): Promise<
    { readonly files: LayoutFiles; readonly date: number | null } | { readonly error: CheckError }
  > {
    const { deps } = this;
    const out: Partial<Record<keyof LayoutFiles, Uint8Array>> = {};
    let date: number | null = null;
    for (const { file, max } of CHECK_FILES) {
      const held = this.#held?.files[FIELD[file]];
      const result: RegistryFetchResult = await deps.fetcher.fetch({
        path: file,
        maxBytes: max,
        ...(held !== undefined && { heldSha256: deps.sha256(held) }),
      });
      if (result.kind === 'failed') {
        this.#log.warn('registry fetch failed', {
          file,
          reason: result.reason,
          detail: result.detail,
        });
        return { error: { code: result.reason, message: `${file}: ${result.detail}` } };
      }
      if (result.date !== null) date = result.date;
      if (result.kind === 'not_modified') {
        if (held === undefined) {
          return { error: { code: 'not_modified_without_body', message: `${file}: 304` } };
        }
        out[FIELD[file]] = held;
      } else {
        out[FIELD[file]] = result.bytes;
      }
    }
    const { keys, keysSig, index, indexSig } = out;
    if (
      keys === undefined ||
      keysSig === undefined ||
      index === undefined ||
      indexSig === undefined
    ) {
      return { error: { code: 'missing', message: 'a registry file is missing' } };
    }
    return { files: { keys, keysSig, index, indexSig }, date };
  }

  /** Stores what an accepted fetch established; a refusal changes nothing (spec 13 §10.3 step 4). */
  async #acceptFetched(
    acceptance: Acceptance,
    files: LayoutFiles,
  ): Promise<{ outcome: SitePackCheckResponse['outcome']; error?: CheckError; stale: boolean }> {
    switch (acceptance.kind) {
      case 'refused': {
        const { refusal } = acceptance;
        this.#log.warn('registry file refused', { ...refusal });
        return {
          outcome: 'failed',
          error: { code: refusal.reason, message: `${refusal.file}: ${refusal.detail}` },
          stale: this.held()?.stale ?? false,
        };
      }
      case 'stale':
        await this.#storeKeys(acceptance.keys.value, files);
        return {
          outcome: 'failed',
          error: {
            code: STALE,
            message: 'the registry index has expired and no fresh one is published',
          },
          stale: true,
        };
      case 'not_modified':
        await this.#storeKeys(acceptance.keys.value, files);
        return { outcome: 'not_modified', stale: false };
      case 'updated':
        await this.adopt(acceptance, files, { origin: 'registry', name: null });
        return { outcome: 'updated', stale: false };
    }
  }

  /** Keeps a newer `keys.json` of an unchanged index (its floor only ever rises). */
  async #storeKeys(keys: HeldState['keys'], files: LayoutFiles): Promise<void> {
    const held = this.#held;
    const keysVersion = keys.version;
    if (held === null || keysVersion === held.keys.version) return;
    await this.#deps.held.write({ 'keys.json': files.keys, 'keys.json.sig': files.keysSig });
    this.#held = {
      ...held,
      keys,
      files: { ...held.files, keys: files.keys, keysSig: files.keysSig },
    };
    this.#floors = { ...this.#floors, keysVersion };
    await writeFloors(this.#deps.meta, {
      keysVersion,
      indexVersion: this.#floors.indexVersion ?? held.index.version,
    });
    this.#record = { ...this.#record, keys_sha256: this.#deps.sha256(files.keys) };
    await writeClient(this.#deps.meta, this.#record);
  }

  /** Makes an accepted, newer layout the held one: files, floors, the record (fetch or import). */
  async adopt(
    acceptance: Extract<Acceptance, { kind: 'updated' | 'not_modified' }>,
    files: LayoutFiles,
    from: { readonly origin: HeldState['origin']; readonly name: string | null },
  ): Promise<void> {
    const { deps } = this;
    await deps.held.write({
      'keys.json': files.keys,
      'keys.json.sig': files.keysSig,
      'index.json': files.index,
      'index.json.sig': files.indexSig,
    });
    const floors = floorsAfter(acceptance);
    await writeFloors(deps.meta, floors);
    this.#floors = floors;
    this.#held = {
      files,
      keys: acceptance.keys.value,
      index: acceptance.index.value,
      signedBy: acceptance.index.signedBy,
      origin: from.origin,
      originName: from.name,
    };
    this.#record = {
      ...this.#record,
      index_sha256: deps.sha256(files.index),
      keys_sha256: deps.sha256(files.keys),
      signed_by: acceptance.index.signedBy,
      index_origin: from.origin,
      origin_name: from.name,
    };
    await writeClient(deps.meta, this.#record);
    this.#log.info('registry index accepted', {
      version: acceptance.index.value.version,
      keys_version: acceptance.keys.value.version,
      origin: from.origin,
      ...(acceptance.kind === 'updated' &&
        acceptance.indexFloorApplied !== null && { index_floor: acceptance.indexFloorApplied }),
    });
  }

  /** Records the check's outcome, the degradations, the audit row and the next check. */
  async #finish(
    now: number,
    outcome: SitePackCheckResponse['outcome'],
    error: CheckError | undefined,
    by: string | undefined,
  ): Promise<void> {
    const { deps } = this;
    const failed = outcome === 'failed';
    this.#record = {
      ...this.#record,
      last_check_at: now,
      last_outcome: outcome,
      ...(failed
        ? { last_error: error ?? null, failures: this.#record.failures + 1 }
        : { last_error: null, failures: 0, last_ok_at: now }),
    };
    await writeClient(deps.meta, this.#record);
    if (this.#record.failures >= FAILURES_DEGRADED) {
      deps.degradations?.report({
        code: FETCH_FAILED,
        severity: 'warn',
        message: `The site-pack update check failed ${this.#record.failures} times in a row: ${error?.message ?? 'unknown error'}. Approved packs keep applying.`,
        details: { failures: this.#record.failures, last_error: error?.message ?? '' },
      });
    } else if (!failed) {
      deps.degradations?.recovered(FETCH_FAILED);
    }
    this.#reportStale();
    if (by !== undefined) {
      await deps.repos.operatorActions.append({
        eventId: deps.ids.eventId(),
        principalId: by,
        action: 'site_pack.check',
        resourceKind: 'site_pack',
        resourceId: null,
        details: {
          outcome,
          index_version: this.#held?.index.version ?? null,
          ...(error !== undefined && { error: error.code }),
        },
        occurredAt: now,
      });
    }
    await deps.registry.mutate(async () => undefined);
  }

  #reportStale(): void {
    const held = this.held();
    const { degradations } = this.#deps;
    if (held === null || !held.stale) {
      degradations?.recovered(STALE);
      return;
    }
    const skew = this.#record.clock_skew_ms;
    const clockText =
      skew !== undefined && Math.abs(skew) > SKEW_CLOCK_HINT_MS
        ? ` The registry's clock and this machine's differ by ${Math.round(Math.abs(skew) / MINUTE)} minutes: check the system clock.`
        : '';
    degradations?.report({
      code: STALE,
      severity: 'warn',
      message: `The site-pack registry index (version ${held.index.version}) expired ${held.index.expires} and no fresh one verified; the last good index stays in force and nothing new is downloaded from it.${clockText}`,
      details: {
        index_version: held.index.version,
        expired_at: held.index.expires,
        ...(skew !== undefined && { clock_skew_ms: skew }),
        clock_text: clockText,
      },
    });
  }

  #noteSkew(date: number | null, now: number): void {
    if (date === null) return;
    const skew = date - now;
    const { clock_skew_ms: _old, ...rest } = this.#record;
    this.#record = Math.abs(skew) > SKEW_REPORTED_MS ? { ...rest, clock_skew_ms: skew } : rest;
  }

  async #seedFromSnapshot(): Promise<void> {
    const store = this.#deps.snapshot;
    if (store === undefined) return;
    this.#snapshot = await readSnapshot(store, this.#deps.verifier).catch(() => null);
    const snap = this.#snapshot;
    if (snap === null || !snap.verified || this.#floors.indexVersion !== null) return;
    const floors = { keysVersion: snap.keysVersion, indexVersion: snap.indexVersion };
    await writeFloors(this.#deps.meta, floors);
    this.#floors = floors;
    this.#log.info('floors from the snapshot', { ...floors });
  }

  // --- downloads, imports, export (client-ops.ts) ---------------------------------------------

  /** **Download & review** of one listed version (`POST /site-packs/{id}/download`). */
  download(packId: string, version: number, by: string): Promise<SitePackDownloadResponse> {
    return this.#serial(() => ops.download(this.#ctx(), packId, version, by));
  }

  /** **Download all** (`POST /site-packs/download-all`). */
  downloadAll(by: string): Promise<SitePackDownloadAllResponse> {
    return this.#serial(() => ops.downloadAll(this.#ctx(), by));
  }

  /** A signed layout (`POST /site-packs/import {files}`, `sitepacks import <dir>`). */
  importLayout(
    files: ReadonlyMap<string, Uint8Array>,
    name: string,
    by: string,
  ): Promise<SitePackImportResponse> {
    return this.#serial(() => ops.importFiles(this.#ctx(), files, { origin: 'import', name, by }));
  }

  /** The held layout and every verified pack file held (`GET /site-packs/export`). */
  exportLayout(): Promise<SitePackExportResponse> {
    return this.#serial(() => ops.exportLayout(this.#ctx()));
  }

  // --- internals ------------------------------------------------------------------------------

  #ctx(): ops.ClientContext {
    return {
      deps: this.#deps,
      log: this.#log,
      held: () => this.held(),
      heldState: () => this.#held,
      floors: () => this.#floors,
      checkOff: () => this.checkOff,
      record: () => this.#record,
      setRecord: async (record) => {
        this.#record = record;
        await writeClient(this.#deps.meta, record);
      },
      adopt: (acceptance, files, from) => this.adopt(acceptance, files, from),
    };
  }

  #status() {
    return this.#deps.registry.status();
  }

  #scheduleNext(delayMs: number): void {
    if (this.#stopped) return;
    this.#cancel?.();
    this.#nextAt = this.#deps.clock.now() + delayMs;
    this.#cancel = this.#deps.schedule(() => {
      void this.#tick();
    }, delayMs);
  }

  async #tick(): Promise<void> {
    if (this.#stopped) return;
    try {
      await this.check();
    } catch (err) {
      this.#log.warn('update check failed', { err: serializeError(err) });
    }
    this.#scheduleNext(this.#nextDelay());
  }

  /** 24 h ± 2 h, or after failures 1 h, 2 h, 4 h … up to that (spec 13 §10.4). */
  #nextDelay(): number {
    const interval = this.#deps.intervalMs ?? CHECK_INTERVAL_MS;
    const random = this.#deps.random ?? Math.random;
    // ± 2 h of 24 h (one twelfth of the interval).
    const scheduled = interval + Math.round((random() * 2 - 1) * (interval / 12));
    const failures = this.#record.failures;
    if (failures === 0) return scheduled;
    return Math.min(scheduled, HOUR * 2 ** Math.min(failures - 1, 5));
  }

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(fn, fn);
    this.#tail = run.catch(() => undefined);
    return run;
  }
}

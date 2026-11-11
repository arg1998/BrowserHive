/** @module app/templates/template-state — a template's checkpoint and versions (spec 13 §2.4, §3.9): the rolling checkpoint rewritten every `templateCheckpointInterval` with carry-forward and the 64 MiB cap, versions at milestones (`recording`, `relogin`, `restore`, `manual`, `import`, `signin_change`, `daily`), retention with pinned versions and "Last good". The host is the only writer; this service serializes every write per template. */

import type { TemplateVersionRow, TemplateVersionsPage } from '@browserhive/contracts/http';
import {
  checkpointVersionReason,
  structureHash,
  summarize,
  withoutDomain,
} from '../../domain/templates/state-model.ts';
import { AppError } from '../../kernel/errors/app-error.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Logger } from '../../ports/logger.ts';
import type {
  TemplateRecord,
  TemplateSiteRecord,
  TemplateVersionReason,
} from '../../ports/persistence/index.ts';
import type { StateSlot, TemplateState } from '../../ports/template-state.ts';
import { KeyedQueue } from './keyed-queue.ts';
import { inTemplateSpan } from './spans.ts';
import {
  captureState,
  pruneVersions,
  readableSlots,
  signInNamesOf,
  type TemplateStateDeps,
  type VersionRequest,
  versionNotFound,
  versionRows,
  writeVersion,
} from './state-writes.ts';

export {
  signInNamesOf,
  type TemplateStateConfig,
  type TemplateStateDeps,
  type VersionRequest,
  versionNotFound,
} from './state-writes.ts';

import { notFoundForOperator } from './template-errors.ts';
import { pageVersions } from './version-views.ts';

/** The outcome of a checkpoint. */
export type CheckpointOutcome =
  | { readonly written: false; readonly why: 'no_key' | 'not_running' | 'failed' | 'gone' }
  | { readonly written: true; readonly version: number | null };

/** `CONFLICT` with an operator-facing message. */
function conflict(message: string): AppError<'CONFLICT'> {
  return new AppError('CONFLICT', {}, { publicMessage: message });
}

/** A template's checkpoint and versions. */
export class TemplateStateService {
  readonly #deps: TemplateStateDeps;
  readonly #log: Logger;
  readonly #queue = new KeyedQueue();
  /** Templates whose last write failed (`TEMPLATE_CHECKPOINT_FAILED` is recovered on success). */
  readonly #failing = new Set<string>();

  constructor(deps: TemplateStateDeps) {
    this.#deps = deps;
    this.#log = deps.logger.child({ module: 'templates.state' });
  }

  /** Whether files can be written (`TEMPLATE_KEY_MISSING` otherwise). */
  get writable(): boolean {
    return this.#deps.store.keys.current !== null;
  }

  /** Whether the checkpoint of `template` is due at `now` (spec 13 §3.9). */
  due(
    template: Pick<TemplateRecord, 'checkpointAt'>,
    now: number,
    startedAt: number | null,
  ): boolean {
    const since = template.checkpointAt ?? startedAt;
    return since === null || now - since >= this.#deps.config.checkpointIntervalMs;
  }

  /** The interval pass (the supervisor's tick): a checkpoint when it is due. Never throws. */
  async checkpointIfDue(templateId: string, startedAt: number | null): Promise<void> {
    if (!this.writable || this.#queue.busy(templateId)) return;
    const template = await this.#deps.repos.templates.get(templateId).catch(() => null);
    if (template === null || !this.due(template, this.#deps.clock.now(), startedAt)) return;
    await this.checkpoint(templateId);
  }

  /**
   * Rewrites the rolling checkpoint from the running host (interval, clean stop, shutdown) and
   * writes the `signin_change` or `daily` version it calls for. Never throws: a failure is the
   * `TEMPLATE_CHECKPOINT_FAILED` degradation and the previous file and row stay.
   */
  checkpoint(templateId: string): Promise<CheckpointOutcome> {
    if (!this.writable) return Promise.resolve({ written: false, why: 'no_key' });
    return this.#queue.run(templateId, () =>
      inTemplateSpan(
        'template.checkpoint',
        { 'browserhive.template_id': templateId },
        () => this.#checkpointNow(templateId),
        (out) =>
          out.written && out.version !== null ? { 'browserhive.version': out.version } : {},
      ),
    );
  }

  async #checkpointNow(templateId: string): Promise<CheckpointOutcome> {
    {
      const host = this.#deps.hostOf(templateId);
      if (host === null) return { written: false, why: 'not_running' };
      const loaded = await this.#load(templateId);
      if (loaded === null) return { written: false, why: 'gone' };
      try {
        const state = await captureState(this.#deps, this.#log, loaded.template, host);
        await this.#writeCheckpoint(templateId, state, 'checkpoint');
        const versions = await this.#deps.repos.templateVersions.list(templateId);
        const newest = versions[0] ?? null;
        const reason = checkpointVersionReason({
          now: this.#deps.clock.now(),
          previousCheckpointAt: loaded.template.checkpointAt,
          summary: summarize(state, signInNamesOf(loaded.sites)),
          structure: structureHash(state),
          newest,
          sites: loaded.sites.filter((s) => s.enabled).map((s) => s.siteId),
          ...(this.#deps.config.timeZone !== undefined && { timeZone: this.#deps.config.timeZone }),
        });
        const version =
          reason === null
            ? null
            : await writeVersion(
                this.#deps,
                this.#log,
                loaded.template,
                loaded.sites,
                state,
                versions,
                {
                  reason,
                  by: 'browserhive',
                },
              );
        this.#recovered(templateId);
        return { written: true, version };
      } catch (err) {
        this.#failed(templateId, err);
        return { written: false, why: 'failed' };
      }
    }
  }

  /**
   * Writes a version from the running host's state (Finish, `manual`, a restore or a seed after its
   * state was applied), and rewrites the checkpoint with the same state. `null` when
   * `onlyIfChanged` and the structure equals the newest version's.
   *
   * @throws AppError `CONFLICT` (the browser is not running), `TEMPLATE_VERSION_UNREADABLE` (no
   *   key), or the write's error.
   */
  saveVersion(templateId: string, request: VersionRequest): Promise<number | null> {
    return this.#queue.run(templateId, async () => {
      const host = this.#deps.hostOf(templateId);
      if (host === null) throw conflict("The template's browser is not running; start it first.");
      if (!this.writable) {
        throw new AppError(
          'TEMPLATE_VERSION_UNREADABLE',
          { template_id: templateId, version: 'latest', key_id: '' },
          { publicMessage: 'No template key resolves, so no version can be written.' },
        );
      }
      const loaded = await this.#load(templateId);
      if (loaded === null) throw notFoundForOperator(templateId);
      const state = await captureState(this.#deps, this.#log, loaded.template, host);
      const versions = await this.#deps.repos.templateVersions.list(templateId);
      if (request.onlyIfChanged === true && versions[0]?.structureSha256 === structureHash(state)) {
        return null;
      }
      try {
        await this.#writeCheckpoint(templateId, state, null);
        const version = await writeVersion(
          this.#deps,
          this.#log,
          loaded.template,
          loaded.sites,
          state,
          versions,
          request,
        );
        this.#recovered(templateId);
        return version;
      } catch (err) {
        this.#failed(templateId, err);
        throw err;
      }
    });
  }

  /**
   * After a sign-in removal: the checkpoint is rewritten without the domain, so a later
   * carry-forward cannot bring it back (spec 13 §2.3, §3.9). Best effort.
   */
  forgetDomain(templateId: string, domain: string): Promise<void> {
    if (!this.writable) return Promise.resolve();
    return this.#queue.run(templateId, async () => {
      const template = await this.#deps.repos.templates.get(templateId);
      if (template === null || template.checkpointAt === null) return;
      try {
        const latest = await this.#deps.store.read(templateId, 'latest');
        await this.#writeCheckpoint(templateId, withoutDomain(latest, domain), null);
      } catch (err) {
        this.#log.warn('checkpoint not cleaned', { templateId, err: serializeError(err) });
      }
    });
  }

  /**
   * A slot's decrypted state, for a restore (spec 13 §3.12).
   *
   * @throws AppError `TEMPLATE_VERSION_NOT_FOUND`, `TEMPLATE_VERSION_UNREADABLE`.
   */
  async read(templateId: string, slot: StateSlot): Promise<TemplateState> {
    await this.#requireSlot(templateId, slot);
    return await this.#deps.store.read(templateId, slot);
  }

  /** `GET /templates/{id}/versions` (spec 13 §11.1). */
  async list(
    templateId: string,
    query: { readonly cursor?: string | undefined; readonly limit: number },
  ): Promise<TemplateVersionsPage> {
    const template = await this.#deps.repos.templates.get(templateId);
    if (template === null) throw notFoundForOperator(templateId);
    const rows = await this.rows(templateId);
    const readable = await readableSlots(this.#deps, templateId);
    const checkpoint =
      template.checkpointAt === null
        ? null
        : {
            at: template.checkpointAt,
            size_bytes: template.checkpointSizeBytes ?? 0,
            readable: readable.get('latest') === true,
          };
    return pageVersions(rows, query, checkpoint, this.#deps.clock.now());
  }

  /** Every version as operators see it, newest first. */
  rows(templateId: string): Promise<readonly TemplateVersionRow[]> {
    return versionRows(this.#deps, templateId);
  }

  /**
   * `PATCH /templates/{id}/versions/{version}`: pins or unpins (a pinned version survives
   * retention); unpinning prunes.
   *
   * @throws AppError `TEMPLATE_VERSION_NOT_FOUND`.
   */
  pin(templateId: string, version: number, pinned: boolean): Promise<TemplateVersionRow> {
    return this.#queue.run(templateId, async () => {
      const row = await this.#deps.repos.templateVersions.setPinned(templateId, version, pinned);
      if (row === null) throw versionNotFound(templateId, version);
      // Read before pruning: an unpinned version past retention is deleted right after.
      const rows = await this.rows(templateId);
      const view = rows.find((r) => r.version === version);
      if (view === undefined) throw versionNotFound(templateId, version);
      if (!pinned) await pruneVersions(this.#deps, this.#log, templateId);
      this.#deps.bus?.publish('template.version', {
        type: 'template.version',
        template_id: templateId,
        version: view,
      });
      return view;
    });
  }

  // --- internals ----------------------------------------------------------------------------------

  async #load(
    templateId: string,
  ): Promise<{ template: TemplateRecord; sites: readonly TemplateSiteRecord[] } | null> {
    const template = await this.#deps.repos.templates.get(templateId);
    if (template === null) return null;
    return { template, sites: await this.#deps.repos.templateSites.list(templateId) };
  }

  async #writeCheckpoint(
    templateId: string,
    state: TemplateState,
    metric: 'checkpoint' | null,
  ): Promise<void> {
    const file = await this.#deps.store.write(templateId, 'latest', state);
    await this.#deps.repos.templates.setStateFacts(templateId, {
      checkpointAt: this.#deps.clock.now(),
      checkpointSizeBytes: file.sizeBytes,
    });
    if (metric !== null) this.#written(templateId, metric);
  }

  async #requireSlot(templateId: string, slot: StateSlot): Promise<void> {
    const template = await this.#deps.repos.templates.get(templateId);
    if (template === null) throw notFoundForOperator(templateId);
    const known =
      slot === 'latest'
        ? template.checkpointAt !== null
        : (await this.#deps.repos.templateVersions.get(templateId, slot)) !== null;
    if (!known) throw versionNotFound(templateId, slot);
  }

  #written(templateId: string, reason: 'checkpoint' | TemplateVersionReason): void {
    this.#deps.bus?.publish('template.checkpoint.written', {
      type: 'template.checkpoint.written',
      template_id: templateId,
      reason,
    });
  }

  #failed(templateId: string, err: unknown): void {
    const error = serializeError(err).message;
    this.#log.warn('template checkpoint failed', { templateId, err: serializeError(err) });
    this.#failing.add(templateId);
    this.#deps.degradations.report({
      code: 'TEMPLATE_CHECKPOINT_FAILED',
      severity: 'warn',
      message: `template ${templateId} checkpoint failed: ${error}`,
      details: { template_id: templateId, error },
    });
  }

  #recovered(templateId: string): void {
    if (!this.#failing.delete(templateId)) return;
    if (this.#failing.size === 0) this.#deps.degradations.recovered('TEMPLATE_CHECKPOINT_FAILED');
  }
}

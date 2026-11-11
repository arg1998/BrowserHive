/** @module app/templates/state-writes — the writes behind `TemplateStateService` (spec 13 §2.4, §3.9): capturing the host's state with carry-forward and the cap, writing a version file before its row (no file without a row), its `.meta.json`, retention, and the operator view of the versions. */

import type { TemplateVersionRow } from '@browserhive/contracts/http';
import {
  capState,
  carryForward,
  lastGood,
  prunableVersions,
  type SignInNames,
  signInCompleteness,
  structureHash,
  summarize,
} from '../../domain/templates/state-model.ts';
import { AppError, isAppError } from '../../kernel/errors/app-error.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Clock } from '../../ports/clock.ts';
import type { DegradationReporter } from '../../ports/degradation-reporter.ts';
import type { EventPublisher } from '../../ports/event-bus.ts';
import type { Logger } from '../../ports/logger.ts';
import type {
  Repositories,
  TemplateRecord,
  TemplateSiteRecord,
  TemplateVersionReason,
  TemplateVersionRecord,
} from '../../ports/persistence/index.ts';
import type { TemplateHost } from '../../ports/template-host.ts';
import type { StateSlot, TemplateState, TemplateStateStore } from '../../ports/template-state.ts';
import type { DomainEvents } from '../events/catalog.ts';
import { toVersionRow } from './version-views.ts';

/** Settings (spec 08 §5.9). */
export interface TemplateStateConfig {
  /** `templateCheckpointInterval`. */
  readonly checkpointIntervalMs: number;
  /** `templateVersionsKeep`. */
  readonly versionsKeep: number;
  /** The host's time zone for `daily` (default: the process's). */
  readonly timeZone?: string;
}

/** Collaborators of {@link TemplateStateService}. */
export interface TemplateStateDeps {
  readonly repos: Pick<Repositories, 'templates' | 'templateSites' | 'templateVersions'>;
  readonly store: TemplateStateStore;
  /** The running host of a template, or `null`. */
  readonly hostOf: (templateId: string) => TemplateHost | null;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly degradations: DegradationReporter;
  readonly bus?: EventPublisher<DomainEvents>;
  readonly config: TemplateStateConfig;
}

/** Who writes a version and why. */
export interface VersionRequest {
  readonly reason: TemplateVersionReason;
  /** The principal, or `browserhive` for automatic versions. */
  readonly by: string;
  /** `restore`: the version restored (`0` = the rolling checkpoint). */
  readonly restoredFrom?: number | null;
  /** `manual`: write nothing when the structure has not changed since the newest version. */
  readonly onlyIfChanged?: boolean;
}

/** The host's state with the previous checkpoint's unvisited origins carried forward, capped. */
export async function captureState(
  deps: TemplateStateDeps,
  log: Logger,
  template: TemplateRecord,
  host: TemplateHost,
): Promise<TemplateState> {
  const snapshot = await host.storageState();
  let previous: TemplateState | null = null;
  if (template.checkpointAt !== null) {
    try {
      previous = await deps.store.read(template.templateId, 'latest');
    } catch (err) {
      // Written with a key this process does not hold: `rekey` (or `templateKeyPrevious`) can
      // still recover it, so it is never overwritten (review #79 M-1).
      if (onOtherKey(deps, err)) throw keyMismatch(deps, template.templateId);
      log.warn('checkpoint unreadable', {
        templateId: template.templateId,
        err: serializeError(err),
      });
    }
  }
  const capped = capState(carryForward(snapshot, previous, host.visitedOrigins()));
  if (capped.dropped.length > 0) {
    deps.degradations.report({
      code: 'TEMPLATE_CHECKPOINT_TOO_LARGE',
      severity: 'warn',
      message: `template ${template.templateId} state over the cap; IndexedDB of ${capped.dropped.length} origin(s) left out`,
      details: {
        template_id: template.templateId,
        size_bytes: capped.sizeBytes,
        dropped_origins: [...capped.dropped],
      },
    });
  }
  return capped.state;
}

/** True for `TEMPLATE_VERSION_UNREADABLE` of a file whose header names a key not held now. */
export function onOtherKey(deps: Pick<TemplateStateDeps, 'store'>, err: unknown): boolean {
  if (!isAppError(err) || err.code !== 'TEMPLATE_VERSION_UNREADABLE') return false;
  const keyId = (err.details as { key_id?: unknown }).key_id;
  const keys = deps.store.keys;
  return (
    typeof keyId === 'string' &&
    keyId !== '' &&
    keyId !== keys.current?.keyId &&
    keyId !== keys.previous?.keyId
  );
}

/** Records `TEMPLATE_KEY_MISMATCH` for the checkpoint and returns the error that skips the write. */
function keyMismatch(
  deps: TemplateStateDeps,
  templateId: string,
): AppError<'TEMPLATE_VERSION_UNREADABLE'> {
  deps.degradations.report({
    code: 'TEMPLATE_KEY_MISMATCH',
    severity: 'warn',
    message: `template ${templateId} checkpoint was written with another key; set templateKeyPrevious and run browserhive templates rekey`,
    details: { template_id: templateId, versions: ['latest'] },
  });
  return new AppError(
    'TEMPLATE_VERSION_UNREADABLE',
    { template_id: templateId, version: 'latest', key_id: '' },
    {
      publicMessage:
        "The template's checkpoint was written with another key; it is kept. Set templateKeyPrevious to that key and run browserhive templates rekey.",
    },
  );
}

/** Writes a version file and its row, then prunes and publishes `template.version`. */
export async function writeVersion(
  deps: TemplateStateDeps,
  log: Logger,
  template: TemplateRecord,
  sites: readonly TemplateSiteRecord[],
  state: TemplateState,
  existing: readonly TemplateVersionRecord[],
  request: VersionRequest,
): Promise<number> {
  const { store, repos } = deps;
  const templateId = template.templateId;
  const version = Math.max(template.currentVersion ?? 0, existing[0]?.version ?? 0) + 1;
  const file = await store.write(templateId, version, state);
  const summary = summarize(state, signInNamesOf(sites));
  const record: TemplateVersionRecord = {
    templateId,
    version,
    reason: request.reason,
    restoredFrom: request.restoredFrom ?? null,
    ...file,
    structureSha256: structureHash(state),
    summary,
    health: sites.map((s) => ({
      siteId: s.siteId,
      state: s.health.state,
      enabled: s.enabled,
      signInComplete: signInCompleteness(summary, s.siteId, s.learnedCookieNames),
    })),
    pinned: false,
    createdBy: request.by,
    createdAt: deps.clock.now(),
  };
  try {
    await repos.templateVersions.insert(record);
  } catch (err) {
    // No file without a row.
    await store.remove(templateId, version).catch(() => undefined);
    throw err;
  }
  await store
    .writeMeta(templateId, version, {
      version,
      created_at: record.createdAt,
      reason: record.reason,
      size_bytes: record.sizeBytes,
      sha256: record.sha256,
      key_id: record.keyId,
      summary: toVersionRow(record, { lastGood: null, readable: true }).summary,
    })
    .catch((err: unknown) => log.warn('version meta not written', { err: serializeError(err) }));
  await repos.templates.setStateFacts(templateId, { currentVersion: version });
  deps.bus?.publish('template.checkpoint.written', {
    type: 'template.checkpoint.written',
    template_id: templateId,
    reason: request.reason,
  });
  log.info('template version written', { templateId, version, reason: request.reason });
  await pruneVersions(deps, log, templateId);
  const row = (await versionRows(deps, templateId)).find((r) => r.version === version);
  if (row !== undefined) {
    deps.bus?.publish('template.version', {
      type: 'template.version',
      template_id: templateId,
      version: row,
    });
  }
  return version;
}

/** Deletes versions retention no longer keeps, files first (spec 13 §3.9). */
export async function pruneVersions(
  deps: TemplateStateDeps,
  log: Logger,
  templateId: string,
): Promise<void> {
  const versions = await deps.repos.templateVersions.list(templateId);
  const files = await readableSlots(deps, templateId);
  // A file on another key is kept and not counted: `rekey` may still recover it (review #79 M-1).
  const readable = (version: number) => files.get(version) !== false;
  for (const version of prunableVersions(versions, deps.config.versionsKeep, readable)) {
    await deps.store.remove(templateId, version);
    await deps.repos.templateVersions.remove(templateId, version);
    log.info('template version pruned', { templateId, version });
  }
}

/** Whether each state file of a template opens with a key this process holds. */
export async function readableSlots(
  deps: Pick<TemplateStateDeps, 'store'>,
  templateId: string,
): Promise<Map<StateSlot, boolean>> {
  const keys = deps.store.keys;
  const ids = new Set([keys.current?.keyId, keys.previous?.keyId].filter((k) => k !== undefined));
  const out = new Map<StateSlot, boolean>();
  for (const file of await deps.store.files(templateId)) {
    out.set(file.slot, file.keyId !== null && ids.has(file.keyId));
  }
  return out;
}

/** Every version as operators see it, newest first. */
export async function versionRows(
  deps: Pick<TemplateStateDeps, 'store' | 'repos'>,
  templateId: string,
): Promise<readonly TemplateVersionRow[]> {
  const versions = await deps.repos.templateVersions.list(templateId);
  const readable = await readableSlots(deps, templateId);
  const good = lastGood(versions);
  return versions.map((v) =>
    toVersionRow(v, { lastGood: good, readable: readable.get(v.version) === true }),
  );
}

/** The sign-in cookie names of each site (learned names; packs' `cookie_names` from T3a). */
export function signInNamesOf(sites: readonly TemplateSiteRecord[]): SignInNames {
  return new Map(sites.map((s) => [s.siteId, s.learnedCookieNames]));
}

/** `TEMPLATE_VERSION_NOT_FOUND`. */
export function versionNotFound(
  templateId: string,
  version: StateSlot,
): AppError<'TEMPLATE_VERSION_NOT_FOUND'> {
  return new AppError(
    'TEMPLATE_VERSION_NOT_FOUND',
    { template_id: templateId, version },
    { publicMessage: `Template '${templateId}' has no version ${String(version)}.` },
  );
}

/** @module app/preferences/preference-service — per-principal operator preferences validated with the contracts `Preferences` schema (spec 03 §4.8). */

import type { Preferences } from '@browserhive/contracts/http';
import {
  PREFERENCES_MAX_BYTES,
  Preferences as PreferencesSchema,
} from '@browserhive/contracts/http';
import type { z } from 'zod';
import { AppError } from '../../kernel/errors/app-error.ts';
import type { Clock } from '../../ports/clock.ts';
import type { Logger } from '../../ports/logger.ts';
import type { PreferenceRepository } from '../../ports/persistence/notifications.ts';

/** A known preference key. */
export type PreferenceKey = keyof Preferences;

/** Every known key, in schema order. */
export const PREFERENCE_KEYS: readonly PreferenceKey[] = Object.keys(
  PreferencesSchema.shape,
).filter((key): key is PreferenceKey => key in PreferencesSchema.shape);

/** Dependencies of {@link PreferenceService}. */
export interface PreferenceServiceDeps {
  readonly repo: PreferenceRepository;
  readonly clock: Clock;
  readonly logger: Logger;
}

/** The stored document plus the newest `updated_at` across its keys. */
export interface PreferenceDocument {
  readonly preferences: Preferences;
  readonly updatedAt: number | null;
}

const encoder = new TextEncoder();

function validationFailed(error: z.ZodError, extra: readonly string[] = []): AppError {
  return new AppError('VALIDATION_FAILED', {
    issues: [
      ...error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
        code: issue.code,
      })),
      ...extra.map((message) => ({ path: 'preferences', message, code: 'too_big' })),
    ],
  });
}

/**
 * Validates a whole document: known keys only, each value by its schema, ≤ 64 KiB serialised.
 *
 * @returns The parsed document.
 * @throws `VALIDATION_FAILED` listing every issue.
 */
export function parsePreferences(input: unknown): Preferences {
  const result = PreferencesSchema.safeParse(input);
  if (!result.success) throw validationFailed(result.error);
  const bytes = encoder.encode(JSON.stringify(result.data)).byteLength;
  if (bytes > PREFERENCES_MAX_BYTES) {
    throw new AppError('VALIDATION_FAILED', {
      issues: [
        {
          path: 'preferences',
          message: `Preferences must be at most ${PREFERENCES_MAX_BYTES} bytes (got ${bytes}).`,
          code: 'too_big',
        },
      ],
    });
  }
  return result.data;
}

/**
 * Stores one `preferences` row per key. Reads tolerate rows that no longer validate (they are
 * dropped with a warning) so a schema change never breaks the dashboard shell.
 */
export class PreferenceService {
  private readonly log: Logger;

  constructor(private readonly deps: PreferenceServiceDeps) {
    this.log = deps.logger.child({ module: 'preferences' });
  }

  /**
   * The principal's document (`GET /me/preferences`).
   *
   * @returns Known, valid keys only; `updatedAt` is the newest row or `null` when empty.
   */
  async list(principalId: string): Promise<PreferenceDocument> {
    const rows = await this.deps.repo.list(principalId);
    const raw: Record<string, unknown> = {};
    let updatedAt: number | null = null;
    for (const row of rows) {
      raw[row.key] = row.value;
      updatedAt = updatedAt === null ? row.updatedAt : Math.max(updatedAt, row.updatedAt);
    }
    const result = PreferencesSchema.safeParse(raw);
    if (result.success) return { preferences: result.data, updatedAt };
    const bad = new Set(result.error.issues.map((issue) => String(issue.path[0] ?? '')));
    this.log.warn('preferences dropped', { principal: principalId, keys: [...bad] });
    for (const key of bad) delete raw[key];
    const retry = PreferencesSchema.safeParse(raw);
    return { preferences: retry.success ? retry.data : {}, updatedAt };
  }

  /**
   * Replaces the whole document (`PUT /me/preferences`); keys absent from `input` are removed.
   *
   * @returns The stored document and its `updatedAt`.
   * @throws `VALIDATION_FAILED`.
   */
  async replaceAll(principalId: string, input: unknown): Promise<PreferenceDocument> {
    const preferences = parsePreferences(input);
    const at = this.deps.clock.now();
    const values: Record<string, unknown> = {};
    for (const key of PREFERENCE_KEYS) {
      const value = preferences[key];
      if (value !== undefined) values[key] = value;
    }
    await this.deps.repo.replaceAll(principalId, values, at);
    this.log.info('preferences replaced', { principal: principalId, keys: Object.keys(values) });
    return { preferences, updatedAt: at };
  }

  /**
   * Sets one key (validated by its own schema).
   *
   * @returns The `updatedAt` stamp.
   * @throws `VALIDATION_FAILED`.
   */
  async set(principalId: string, key: PreferenceKey, value: unknown): Promise<number> {
    const parsed = PreferencesSchema.shape[key].safeParse(value);
    if (!parsed.success) throw validationFailed(parsed.error);
    const at = this.deps.clock.now();
    if (parsed.data === undefined) await this.deps.repo.remove(principalId, key);
    else await this.deps.repo.set(principalId, key, parsed.data, at);
    return at;
  }
}

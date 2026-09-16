/** @module infra/persistence/mappers/codec — column-level codecs shared by every row mapper (booleans, JSON, enums). */

import { z } from 'zod';
import { AppError } from '../../../kernel/errors/app-error.ts';
import type { JsonObject, JsonValue } from '../../../ports/persistence/records.ts';

const jsonObjectSchema = z.record(z.string(), z.unknown());
const stringArraySchema = z.array(z.string());

/** `true` → 1, `false` → 0. */
export function boolToInt(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

/** Any non-zero integer is `true`. */
export function intToBool(value: number): boolean {
  return value !== 0;
}

/** Raises `INTERNAL_ERROR` for a stored value that violates the schema (corruption, foreign writer). */
function corrupt(where: string, detail: string): AppError {
  return new AppError('INTERNAL_ERROR', { ref: 'row-codec' }, { message: `${where}: ${detail}` });
}

/** Parses a JSON text column that must hold an object. */
export function parseJsonObject(text: string, where: string): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new AppError(
      'INTERNAL_ERROR',
      { ref: 'row-codec' },
      { message: `${where}: invalid json`, cause },
    );
  }
  const parsed = jsonObjectSchema.safeParse(value);
  if (!parsed.success) throw corrupt(where, 'json is not an object');
  return parsed.data;
}

/** Nullable variant of {@link parseJsonObject}. */
export function parseJsonObjectOrNull(text: string | null, where: string): JsonObject | null {
  return text === null ? null : parseJsonObject(text, where);
}

/** Parses a JSON text column holding an array of strings (`scopes_json`, `allowed_origins_json`). */
export function parseStringArray(text: string, where: string): readonly string[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new AppError(
      'INTERNAL_ERROR',
      { ref: 'row-codec' },
      { message: `${where}: invalid json`, cause },
    );
  }
  const parsed = stringArraySchema.safeParse(value);
  if (!parsed.success) throw corrupt(where, 'json is not a string array');
  return parsed.data;
}

/** Parses any JSON text column (`value_json`, `response_json`). */
export function parseJsonValue(text: string, where: string): JsonValue {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new AppError(
      'INTERNAL_ERROR',
      { ref: 'row-codec' },
      { message: `${where}: invalid json`, cause },
    );
  }
}

/** Serialises a JSON value for a text column. `undefined` inside objects is dropped by JSON. */
export function toJson(value: JsonValue): string {
  return JSON.stringify(value ?? null);
}

/** Nullable variant of {@link toJson}. */
export function toJsonOrNull(value: JsonValue | null): string | null {
  return value === null ? null : toJson(value);
}

/** Narrows a stored string to one of `values`; throws `INTERNAL_ERROR` otherwise. */
export function parseEnum<const T extends readonly string[]>(
  values: T,
  value: string,
  where: string,
): T[number] {
  const parsed = z.enum(values).safeParse(value);
  if (!parsed.success) throw corrupt(where, `unexpected value '${value}'`);
  return parsed.data;
}

/** Nullable variant of {@link parseEnum}. */
export function parseEnumOrNull<const T extends readonly string[]>(
  values: T,
  value: string | null,
  where: string,
): T[number] | null {
  return value === null ? null : parseEnum(values, value, where);
}

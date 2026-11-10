/** @module infra/browsers/profile-preferences — the Chromium profile preferences every template host start merges in (spec 13 §3.1): no password saving, no autofill, no browser sign-in, never restore pages. */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** A nested JSON object. */
type JsonObject = { [key: string]: unknown };

/**
 * The preferences of spec 13 §3.1, as Chromium's nested `Preferences` keys. Chrome then offers no
 * "Save password?" or "Sign in to Chrome", autofills nothing, and never offers to restore pages
 * after a crash (`session.restore_on_startup: 5` opens the New Tab page).
 */
export const TEMPLATE_PREFERENCES: JsonObject = {
  credentials_enable_service: false,
  profile: { password_manager_enabled: false, exit_type: 'Normal', exited_cleanly: true },
  autofill: { profile_enabled: false, credit_card_enabled: false },
  signin: { allowed: false },
  session: { restore_on_startup: 5 },
};

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Deep-merges `patch` into `base` (patch wins on leaves); returns a new object. */
export function mergePreferences(base: JsonObject, patch: JsonObject): JsonObject {
  const out: JsonObject = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key];
    out[key] = isObject(value) && isObject(current) ? mergePreferences(current, value) : value;
  }
  return out;
}

/**
 * Merges {@link TEMPLATE_PREFERENCES} into `<userDataDir>/Default/Preferences`, creating the file
 * (and the directories, mode 0700) when absent. An unreadable or non-object file is replaced: the
 * profile is BrowserHive's, and a corrupt `Preferences` would otherwise make Chromium reset it.
 * Written through a temporary file and a rename, so a crash never leaves half a file.
 */
export async function applyTemplatePreferences(userDataDir: string): Promise<void> {
  const dir = join(userDataDir, 'Default');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'Preferences');
  let current: JsonObject = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (isObject(parsed)) current = parsed;
  } catch {
    current = {};
  }
  const tmp = `${path}.browserhive-tmp`;
  await writeFile(tmp, JSON.stringify(mergePreferences(current, TEMPLATE_PREFERENCES)), {
    mode: 0o600,
  });
  await rename(tmp, path);
}

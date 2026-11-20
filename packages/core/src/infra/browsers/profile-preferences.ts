/** @module infra/browsers/profile-preferences — the Chromium profile preferences every template host start merges in (spec 13 §3.1): no password saving, no autofill, no browser sign-in, session cookies kept across restarts ("Continue where you left off", D-78; no window is restored since the host starts with none); and the `webrtc-policy` strategy's `webrtc.ip_handling_policy` (§9.4), set or removed at each start. */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WEBRTC_POLICY_PREFERENCE } from '../../domain/site-packs/host-flags.ts';
import type { WebRtcPolicy } from '../../domain/site-packs/strategy-params.ts';

/** A nested JSON object. */
type JsonObject = { [key: string]: unknown };

/**
 * The preferences of spec 13 §3.1, as Chromium's nested `Preferences` keys. Chrome then offers no
 * "Save password?" or "Sign in to Chrome" and autofills nothing. `session.restore_on_startup: 1`
 * ("Continue where you left off") makes Chrome keep session-only cookies across a restart (it saves
 * them with the profile and loads them at the next start); it restores no window, because a host
 * starts with `--no-startup-window` (D-78; measured on Chromium 153, headed and headless, after a
 * clean close and after the menu's Exit: 0 pages, 0 windows, the session cookie back).
 */
export const TEMPLATE_PREFERENCES: JsonObject = {
  credentials_enable_service: false,
  profile: { password_manager_enabled: false, exit_type: 'Normal', exited_cleanly: true },
  autofill: { profile_enabled: false, credit_card_enabled: false },
  signin: { allowed: false },
  session: { restore_on_startup: 1 },
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
 * Sets the WebRTC IP handling policy preference (`webrtc-policy`), or removes it for `null`: the
 * profile is BrowserHive's, so a policy no enabled site selects any longer leaves no trace.
 */
export function withWebRtcPolicy(prefs: JsonObject, policy: WebRtcPolicy | null): JsonObject {
  const { section, key } = WEBRTC_POLICY_PREFERENCE;
  const current = prefs[section];
  const rest: JsonObject = isObject(current) ? { ...current } : {};
  if (policy === null) {
    if (!(key in rest)) return prefs;
    delete rest[key];
  } else {
    rest[key] = policy;
  }
  return { ...prefs, [section]: rest };
}

/**
 * Merges {@link TEMPLATE_PREFERENCES} into `<userDataDir>/Default/Preferences`, creating the file
 * (and the directories, mode 0700) when absent, and sets or removes the WebRTC policy when
 * `options.webrtcPolicy` is given. An unreadable or non-object file is replaced: the profile is
 * BrowserHive's, and a corrupt `Preferences` would otherwise make Chromium reset it. Written
 * through a temporary file and a rename, so a crash never leaves half a file.
 */
export async function applyTemplatePreferences(
  userDataDir: string,
  options: { readonly webrtcPolicy?: WebRtcPolicy | null } = {},
): Promise<void> {
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
  let next = mergePreferences(current, TEMPLATE_PREFERENCES);
  if (options.webrtcPolicy !== undefined) next = withWebRtcPolicy(next, options.webrtcPolicy);
  await writeFile(tmp, JSON.stringify(next), { mode: 0o600 });
  await rename(tmp, path);
}

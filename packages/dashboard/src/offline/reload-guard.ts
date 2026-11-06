/** @module offline/reload-guard — the offline page's reload loop guard (04 §18.6.4): automatic reloads are counted in `sessionStorage['bh.offline.reloads']` over the last 60 s; the third one, or an unusable `sessionStorage`, stops them. */
import { OFFLINE_RELOADS_KEY, parseReloads } from '../lib/daemon-help/keys.ts';
import { readSessionStorageJson, writeSessionStorageJson } from '../lib/storage.ts';

/** The window the reloads are counted in. */
export const RELOAD_WINDOW_MS = 60_000;

/** The reload that would be the third in the window becomes the loop guard instead. */
export const MAX_AUTO_RELOADS = 3;

/**
 * Records an automatic reload at `nowMs` and says whether the page may perform it: `false` on the
 * third within {@link RELOAD_WINDOW_MS}, or when the timestamp cannot be stored (blocked site
 * data), since the guard could never trip then.
 */
export function claimAutoReload(nowMs: number): boolean {
  const recent = (readSessionStorageJson(OFFLINE_RELOADS_KEY, parseReloads) ?? []).filter(
    (at) => at > nowMs - RELOAD_WINDOW_MS && at <= nowMs,
  );
  recent.push(nowMs);
  if (!writeSessionStorageJson(OFFLINE_RELOADS_KEY, recent)) return false;
  return recent.length < MAX_AUTO_RELOADS;
}

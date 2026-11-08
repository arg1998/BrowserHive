/** @module lib/daemon-help/keys — the two storage keys the dashboard and the offline page share (04 §18.4, §18.6.4) and their validators. Pure; no imports, so the offline build and the root test project can load it. */

/** `localStorage`: `{ version, seen_at }`, written by the dashboard on every boot. */
export const LAST_SEEN_KEY = 'bh.daemon.lastSeen';

/** `sessionStorage`: timestamps of the offline page's automatic reloads; the dashboard clears it on boot. */
export const OFFLINE_RELOADS_KEY = 'bh.offline.reloads';

/** The daemon version the dashboard last ran against here, and when (epoch ms). */
export interface LastSeen {
  readonly version: string;
  readonly seen_at: number;
}

/** A release version, so a tampered value never lands in the page or in a copyable command. */
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Validates a parsed `bh.daemon.lastSeen`; `null` for anything else. */
export function parseLastSeen(raw: unknown): LastSeen | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const version: unknown = Reflect.get(raw, 'version');
  const seenAt: unknown = Reflect.get(raw, 'seen_at');
  if (typeof version !== 'string' || !VERSION_RE.test(version)) return null;
  if (typeof seenAt !== 'number' || !Number.isFinite(seenAt) || seenAt <= 0) return null;
  return { version, seen_at: seenAt };
}

/** Validates a parsed `bh.offline.reloads`: the finite numbers of an array; `null` for anything else. */
export function parseReloads(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value),
  );
}

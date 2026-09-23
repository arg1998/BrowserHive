/** @module app/config/data-dir — OS-default data directory and the `hostMemory → maxSessions` derivation (D-24, D-21) */
import { join } from 'node:path';
import type { HostEnvironment } from '../../ports/host-environment.ts';

/** Bytes per GiB. */
const GIB = 1024 ** 3;
/** GiB of available RAM budgeted per concurrent session (D-21). */
export const RAM_GIB_PER_SESSION = 1.5;
/** Upper bound of the derived `maxSessions` (D-21). */
export const MAX_DERIVED_SESSIONS = 20;

/**
 * OS-default data root (D-24; the platform conventions for per-user application data):
 *
 * - macOS: `~/Library/Application Support/BrowserHive`
 * - Windows: `%LOCALAPPDATA%\BrowserHive` (falls back to `~/AppData/Local/BrowserHive`)
 * - Linux and everything else: `${XDG_DATA_HOME:-~/.local/share}/browserhive`
 *
 * @returns The absolute default data directory for `host`.
 */
export function osDefaultDataDir(host: HostEnvironment): string {
  switch (host.platform) {
    case 'darwin':
      return join(host.homeDir, 'Library', 'Application Support', 'BrowserHive');
    case 'win32': {
      const localAppData = host.env['LOCALAPPDATA'];
      const base =
        localAppData !== undefined && localAppData !== ''
          ? localAppData
          : join(host.homeDir, 'AppData', 'Local');
      return join(base, 'BrowserHive');
    }
    default: {
      const xdg = host.env['XDG_DATA_HOME'];
      const base = xdg !== undefined && xdg !== '' ? xdg : join(host.homeDir, '.local', 'share');
      return join(base, 'browserhive');
    }
  }
}

/**
 * Derived `maxSessions`: `min(floor(RAM_GiB / 1.5), 20)`, never below 1 (D-21).
 *
 * @returns The session cap for a host with `totalMemoryBytes` of RAM.
 */
export function deriveMaxSessions(totalMemoryBytes: number): number {
  const gib = totalMemoryBytes / GIB;
  return Math.max(1, Math.min(Math.floor(gib / RAM_GIB_PER_SESSION), MAX_DERIVED_SESSIONS));
}

/**
 * Whole GiB of available RAM, for the banner (`cap 8 (derived from 12 GiB RAM)`).
 *
 * @returns `totalMemoryBytes` rounded to the nearest GiB.
 */
export function hostRamGib(totalMemoryBytes: number): number {
  return Math.round(totalMemoryBytes / GIB);
}

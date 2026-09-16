/** @module infra/desktop/bun-desktop — "reveal in file manager" via `xdg-open`/`open`/`explorer.exe` through the `ProcessRunner` port. */

import { stat } from 'node:fs/promises';
import type { Desktop, RevealResult } from '../../ports/desktop.ts';
import type { ProcessRunner } from '../../ports/process-runner.ts';

/** Opener timeout: a broken `xdg-open` must not wedge the request. */
export const REVEAL_TIMEOUT_MS = 5_000;

/** Dependencies of {@link createBunDesktop}. */
export interface BunDesktopDeps {
  readonly runner: ProcessRunner;
  /** `process.platform` equivalent from the injected host facts. */
  readonly platform: string;
  /** Injected environment (`DISPLAY`, `WAYLAND_DISPLAY`, `PATH`, `HOME`). */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Directory check seam (tests). */
  readonly isDirectory?: (path: string) => Promise<boolean>;
}

function openerFor(platform: string): string {
  if (platform === 'darwin') return 'open';
  if (platform === 'win32') return 'explorer.exe';
  return 'xdg-open';
}

async function defaultIsDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** The production `Desktop`. Never throws; the path is passed as one argv entry, never a shell. */
export function createBunDesktop(deps: BunDesktopDeps): Desktop {
  const hasDesktopEnvironment = (): boolean => {
    if (deps.platform === 'darwin' || deps.platform === 'win32') return true;
    const display = deps.env['DISPLAY'];
    const wayland = deps.env['WAYLAND_DISPLAY'];
    return (display !== undefined && display !== '') || (wayland !== undefined && wayland !== '');
  };
  return {
    hasDesktopEnvironment,
    async reveal(path) {
      const exists = await (deps.isDirectory ?? defaultIsDirectory)(path);
      const desktop = hasDesktopEnvironment();
      const base: RevealResult = { path, exists, desktop, opened: false };
      if (!exists) return { ...base, reason: 'missing' };
      if (!desktop) return { ...base, reason: 'no_desktop' };
      const command = openerFor(deps.platform);
      const env: Record<string, string> = {};
      for (const key of [
        'PATH',
        'HOME',
        'DISPLAY',
        'WAYLAND_DISPLAY',
        'XDG_RUNTIME_DIR',
        'DBUS_SESSION_BUS_ADDRESS',
      ]) {
        const value = deps.env[key];
        if (value !== undefined) env[key] = value;
      }
      try {
        const result = await deps.runner.run(command, [path], {
          env,
          timeoutMs: REVEAL_TIMEOUT_MS,
        });
        // explorer.exe exits non-zero even on success, so its exit code is not treated as failure.
        if (result.code !== 0 && command !== 'explorer.exe') {
          return { ...base, reason: 'failed', detail: result.stderr.trim().slice(0, 300) };
        }
        return { ...base, opened: true };
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'spawn failed';
        return { ...base, reason: 'failed', detail: detail.slice(0, 300) };
      }
    },
  };
}

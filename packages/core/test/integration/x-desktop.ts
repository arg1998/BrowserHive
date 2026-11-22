/** @module test/integration/x-desktop — the X desktop of the headed Linux legs' focus checks: the window holding the input focus, the window manager's active window, and an operator window (`xmessage`) that really holds the focus before a test samples it. With a window manager it counts as held only once the manager has activated it, so a manager still starting cannot pass for a focus change (its own startup moves the focus from no window to its support window, build-focus-at-start.md). */

import { spawnSync } from 'node:child_process';

function sh(cmd: string, args: readonly string[], timeout = 10_000): string {
  const out = spawnSync(cmd, args, { encoding: 'utf8', timeout });
  return out.status === 0 ? out.stdout.trim() : '';
}

/** The X window with the input focus, in decimal (`xdotool getwindowfocus`); `''` when it names none. */
export function focusedWindow(): string {
  return sh('xdotool', ['getwindowfocus']);
}

/** The window manager's active window (`_NET_ACTIVE_WINDOW`), in decimal; `''` when there is none. */
export function activeWindow(): string {
  const hex = sh('xprop', ['-root', '_NET_ACTIVE_WINDOW']).match(/window id # (0x[0-9a-f]+)/)?.[1];
  return hex === undefined || Number(hex) === 0 ? '' : String(Number(hex));
}

/** The window manager's check window (`_NET_SUPPORTING_WM_CHECK`), as `xprop` prints it. */
function managerCheck(): string {
  return sh('xprop', ['-root', '_NET_SUPPORTING_WM_CHECK']) || 'unreadable';
}

export interface OperatorWindow {
  readonly id: string;
  close(): void;
}

/**
 * Opens the operator's window and gives it the focus: with a window manager (`wm`) activated until
 * both the X focus and `_NET_ACTIVE_WINDOW` name it (the manager may still be starting, D30 n and
 * q), on a bare display focused directly. Throws when it never holds the focus within 10 s.
 */
export function operatorWindow(wm: boolean): OperatorWindow {
  const child = Bun.spawn(['xmessage', '-name', 'bh-operator', 'operator window']);
  // Polled rather than `search --sync`, which exits on X `BadWindow` when another window closes
  // during its walk (deferred D30 g).
  let id = '';
  for (let i = 0; i < 100 && id === ''; i++) {
    id = sh('xdotool', ['search', '--classname', 'bh-operator']).split('\n')[0] ?? '';
    if (id === '') Bun.sleepSync(100);
  }
  if (id === '') {
    child.kill();
    throw new Error('xmessage/xdotool unavailable on the headed leg');
  }
  const held = () => focusedWindow() === id && (!wm || activeWindow() === id);
  const deadline = Date.now() + 10_000;
  while (!held()) {
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(
        `the operator window ${id} never got the focus (focus ${focusedWindow() || 'none'}, active ${activeWindow() || 'none'}, ${wm ? managerCheck() : 'no window manager'})`,
      );
    }
    // Activating needs a window manager; a bare Xvfb only sets the input focus.
    spawnSync('xdotool', [wm ? 'windowactivate' : 'windowfocus', '--sync', id], { timeout: 2_000 });
    if (!held()) Bun.sleepSync(50);
  }
  return { id, close: () => child.kill() };
}

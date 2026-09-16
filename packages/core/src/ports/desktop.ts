/** @module ports/desktop — "reveal in file manager" capability behind `POST /sessions/{id}/data-dir/reveal` (spec 03 §4.2). */

/** Why a reveal did not open a window (wire values of the reveal response). */
export type RevealFailureReason = 'no_desktop' | 'missing' | 'unsupported' | 'failed';

/** Honest outcome of a reveal attempt; the path is always returned so the UI can show/copy it. */
export interface RevealResult {
  readonly path: string;
  /** Whether the directory exists on disk right now. */
  readonly exists: boolean;
  /** Whether a graphical session capable of hosting a file manager was detected. */
  readonly desktop: boolean;
  /** Whether a file-manager window was actually opened. */
  readonly opened: boolean;
  readonly reason?: RevealFailureReason;
  /** Opener stderr on `failed` (capped), for the operator to act on. */
  readonly detail?: string;
}

/** Opens a local directory in the host's file manager. Never throws; every failure is a result. */
export interface Desktop {
  /** True when the host looks graphical (`DISPLAY`/`WAYLAND_DISPLAY`, or macOS/Windows). */
  hasDesktopEnvironment(): boolean;
  /** Reveals `path` (an absolute directory derived server-side, never user-supplied). */
  reveal(path: string): Promise<RevealResult>;
}

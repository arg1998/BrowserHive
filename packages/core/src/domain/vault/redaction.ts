/** @module domain/vault/redaction — per-session credential redaction windows over the kernel SecretRegistry. */

import type { SecretRegistry } from '../../kernel/redact.ts';
import { isUrlAllowed } from './origin.ts';

/** Default cooldown after a fill completes (tool results that echo the value just after the fill are still scrubbed). */
export const DEFAULT_REDACTION_WINDOW_MS = 5_000;

/** Dependencies of {@link VaultRedaction}. */
export interface VaultRedactionDeps {
  /** The shared registry every sink consults; windows are ref-counted there. */
  readonly registry: SecretRegistry;
  readonly now: () => number;
  /** Cooldown after a fill, ms. Default {@link DEFAULT_REDACTION_WINDOW_MS}. */
  readonly windowMs?: number;
}

/**
 * Arms the fetched credential (and, when `redact_username`, the username) for the calling session
 * for the duration of the fill plus the cooldown. While open, tool results for that session pass
 * through {@link VaultRedaction.scrub}. The window closes early on the first navigation **off** the
 * entry's allowed origins — once the agent has left the credential's origin there is nothing left
 * to protect there. Known limits (documented residual risks): substring-only, time-bounded.
 */
export class VaultRedaction {
  private readonly registry: SecretRegistry;
  private readonly now: () => number;
  private readonly windowMs: number;
  private readonly origins = new Map<string, readonly string[]>();

  constructor(deps: VaultRedactionDeps) {
    this.registry = deps.registry;
    this.now = deps.now;
    this.windowMs = deps.windowMs ?? DEFAULT_REDACTION_WINDOW_MS;
  }

  /** Cooldown length in ms. */
  get windowMillis(): number {
    return this.windowMs;
  }

  /**
   * Opens (or re-arms) the session's window covering `secrets` until `now + windowMs`. Re-arming
   * extends the deadline and unions the secret set; literals shorter than 3 chars are ignored.
   */
  arm(sessionId: string, secrets: readonly string[], allowedOrigins: readonly string[]): void {
    this.registry.openWindow(sessionId, secrets, this.windowMs);
    if (this.registry.isWindowOpen(sessionId)) this.origins.set(sessionId, [...allowedOrigins]);
  }

  /** Replaces every armed literal in `text` while the session's window is open; else returns `text`. */
  scrub(sessionId: string, text: string): string {
    if (!this.isActive(sessionId)) return text;
    return this.registry.scrub(text);
  }

  /** True when the session has an unexpired window. */
  isActive(sessionId: string): boolean {
    const open = this.registry.isWindowOpen(sessionId);
    if (!open) this.origins.delete(sessionId);
    return open;
  }

  /** Closes the window when `url` is off the armed allow-list; same-origin navigations keep it. */
  onNavigation(sessionId: string, url: string): void {
    const allowed = this.origins.get(sessionId);
    if (allowed === undefined) return;
    if (!isUrlAllowed(url, allowed)) this.close(sessionId);
  }

  /** Closes a session's window and releases its literals. Idempotent. */
  close(sessionId: string): void {
    this.registry.closeWindow(sessionId);
    this.origins.delete(sessionId);
  }

  /** Closes every window (shutdown, test teardown). */
  closeAll(): void {
    for (const id of [...this.origins.keys()]) this.close(id);
    this.registry.closeAllWindows();
  }
}

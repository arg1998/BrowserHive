/** @module ports/vault-typer — the keystroke seam the vault broker types credentials through (spec 11 §3, §12). */

/** The minimal page surface a typer needs: it can `fill` a selector. Playwright's `Page` satisfies it. */
export interface VaultTyperPage {
  fill(selector: string, value: string, options?: { timeout?: number }): Promise<void>;
}

/** Per-field options the broker passes to the typer. */
export interface VaultTyperOptions {
  /** Field-entry ceiling in ms (the broker's 30 000 ms constant). */
  readonly timeoutMs: number;
}

/**
 * Enters `value` into `selector`. The humanize adapter (`infra/browsers/humanize/vault-typer.ts`)
 * implements it with keystroke cadence and falls back to `fill` on pages without a keyboard; it
 * must never throw over presentation — a login is not the place to fail.
 */
export type VaultTyper = (
  page: VaultTyperPage,
  selector: string,
  value: string,
  options: VaultTyperOptions,
) => Promise<void>;

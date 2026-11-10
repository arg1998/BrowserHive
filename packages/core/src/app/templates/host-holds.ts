/** @module app/templates/host-holds — templates held by an operator operation (spec 13 §3.12 restore, §7.4 seed; D17 clearing saved passwords): while held, agents get `TEMPLATE_UNAVAILABLE` `restarting` and only the holder may start the browser. */

/** One hold; `release` is idempotent. */
export interface TemplateHold {
  readonly token: symbol;
  release(): void;
}

/** The holds, by template id. */
export class TemplateHolds {
  readonly #holds = new Map<string, symbol>();

  /** Takes the hold, or `null` when another operation holds the template. */
  hold(templateId: string): TemplateHold | null {
    if (this.#holds.has(templateId)) return null;
    const token = Symbol(templateId);
    this.#holds.set(templateId, token);
    return {
      token,
      release: () => {
        if (this.#holds.get(templateId) === token) this.#holds.delete(templateId);
      },
    };
  }

  held(templateId: string): boolean {
    return this.#holds.has(templateId);
  }

  /** Whether a launch carrying `token` may proceed (not held, or held by `token`). */
  admits(templateId: string, token: symbol | undefined): boolean {
    const holder = this.#holds.get(templateId);
    return holder === undefined || holder === token;
  }
}

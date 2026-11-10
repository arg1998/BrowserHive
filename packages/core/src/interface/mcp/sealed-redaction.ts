/** @module interface/mcp/sealed-redaction — the dispatcher's redaction of cookie values in sealed template sessions (spec 13 §5.4): before an agent-facing text result leaves the dispatcher, and before it is stored, every cookie value (≥ 12 characters) of the template's browser becomes `[sealed]`. */

import type { Session } from '../../domain/session/session.ts';
import { redactSealed, sealedValues } from '../../domain/templates/redaction.ts';
import type { Clock } from '../../ports/clock.ts';

/** How long a value seen in a template's jar stays redacted after it left the jar (rotated tokens). */
export const SEALED_VALUE_MEMORY_MS = 10 * 60_000;
/** Values remembered per template at most (newest kept). */
export const SEALED_VALUES_MAX = 2_000;

/** What redaction needs from a session: its template and the jar its view reads. */
type SealedSession = Pick<Session, 'template' | 'view'>;

/**
 * Per template, the cookie values agents of sealed sessions must never see. The jar is read once
 * per result (fresh, so a cookie a page set a moment ago is covered), and values seen within
 * {@link SEALED_VALUE_MEMORY_MS} stay covered after the site rotates them; a jar that cannot be read
 * (the browser just went away) falls back to the values already known.
 */
export class SealedRedaction {
  readonly #clock: Clock;
  readonly #seen = new Map<string, Map<string, number>>();

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  /**
   * A scrubber for `session`'s results, or `null` when its principal sees cookie values (exclusive
   * sessions, maintenance sessions, `cookie_values` unsealed).
   */
  async scrubberFor(session: SealedSession | null): Promise<((text: string) => string) | null> {
    const template = session?.template;
    if (session == null || template == null || !template.sealing.hideCookieValues) return null;
    const values = await this.#values(template.templateId, session);
    return (text) => redactSealed(text, values);
  }

  async #values(templateId: string, session: SealedSession): Promise<readonly string[]> {
    const now = this.#clock.now();
    let known = this.#seen.get(templateId);
    if (known === undefined) {
      known = new Map();
      this.#seen.set(templateId, known);
    }
    const view = session.view;
    if (view !== null) {
      try {
        for (const cookie of await view.cookies()) known.set(cookie.value, now);
      } catch {
        // The jar cannot be read (the browser closed): the values already known still apply.
      }
    }
    for (const [value, at] of known) {
      if (now - at > SEALED_VALUE_MEMORY_MS) known.delete(value);
    }
    if (known.size > SEALED_VALUES_MAX) {
      const newest = [...known].sort((a, b) => b[1] - a[1]).slice(0, SEALED_VALUES_MAX);
      known.clear();
      for (const [value, at] of newest) known.set(value, at);
    }
    return sealedValues(known.keys());
  }
}

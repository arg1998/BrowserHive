/** @module interface/mcp/sealed-redaction — the dispatcher's redaction in sealed template sessions (spec 13 §5.4, §14): before an agent-facing text result leaves the dispatcher, and before it is stored, every cookie value of the template's browser and every storage value of its sites (≥ 12 characters, in every escaped or encoded form) becomes `[sealed]`. */

import type { Session } from '../../domain/session/session.ts';
import {
  MIN_SEALED_VALUE_LENGTH,
  redactSealed,
  sealedValues,
} from '../../domain/templates/redaction.ts';
import { registrableDomain } from '../../kernel/url.ts';
import type { Clock } from '../../ports/clock.ts';
import { storageValues } from './sealed-storage.ts';

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
    return await this.scrubberForAll(session === null ? [] : [session]);
  }

  /**
   * One scrubber for results that name several sessions (`list_sessions`, `launch_session`): the
   * values of every sealed one, or `null` when none is sealed.
   */
  async scrubberForAll(
    sessions: readonly SealedSession[],
  ): Promise<((text: string) => string) | null> {
    const sealed = sessions.filter((s) => s.template?.sealing.hideCookieValues === true);
    if (sealed.length === 0) return null;
    const all = new Set<string>();
    for (const session of sealed) {
      const templateId = session.template?.templateId ?? '';
      for (const value of await this.#values(templateId, session)) all.add(value);
    }
    const values = [...all].sort((a, b) => b.length - a.length);
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
    const sites = new Set(session.template?.sites.map((s) => s.site) ?? []);
    const isSite = (url: string): boolean => {
      try {
        return sites.has(registrableDomain(new URL(url).hostname));
      } catch {
        return false;
      }
    };
    // Every value now in the jar is redacted; only the sites' values are remembered after they
    // rotate, so other domains' cookies cannot push them out of the memory (review L-2).
    const current = new Set<string>();
    if (view !== null) {
      try {
        for (const cookie of await view.cookies()) {
          current.add(cookie.value);
          if (sites.has(registrableDomain(cookie.domain.replace(/^\./, '')))) {
            known.set(cookie.value, now);
          }
        }
      } catch {
        // The jar cannot be read (the browser closed): the values already known still apply.
      }
      // The sites' storage values, from the session's own pages on them (spec 13 §14).
      for (const value of await storageValues(view.pages(), isSite, MIN_SEALED_VALUE_LENGTH)) {
        known.set(value, now);
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
    return sealedValues([...current, ...known.keys()]);
  }
}

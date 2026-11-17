/** @module app/templates/template-pause — agents wait while the operator signs in (owner decision 2026-11-16, D-60, deferred D19 B): while a re-login or recording window is open on a template, new launches and the tool calls of its sessions wait, bounded, then answer `TEMPLATE_UNAVAILABLE` `paused`; the operator can let them continue. */

import type { Clock } from '../../ports/clock.ts';
import { templateUnavailable } from './template-admission.ts';

/**
 * How long a tool call or launch waits for the operator before `TEMPLATE_UNAVAILABLE` `paused`.
 * Short enough that the wait plus the tool's own default timeout (30 s) stays below 55 s, under
 * the 60 s timeout of common MCP clients (a client that times out may resend while the first call
 * still runs); a launch counts the wait in its 50 s budget.
 */
export const PAUSE_WAIT_MS = 15_000;
/** What `retry_after_ms` suggests once the wait ran out. */
export const PAUSE_RETRY_AFTER_MS = 15_000;
/** How often a waiting call looks again. */
const PAUSE_POLL_MS = 250;

/** One template's sign-in windows. */
interface PauseState {
  /** Maintenance sessions holding a sign-in window. */
  readonly windows: Set<string>;
  /** The operator let agents continue while these windows are open. */
  released: boolean;
}

/** Collaborators of {@link TemplatePause}. */
export interface TemplatePauseDeps {
  readonly clock: Clock;
  /** Whether a maintenance session still holds its window (a window closed any way ends the pause). */
  readonly alive: (sessionId: string) => boolean;
  /** The pause of a template started or ended (`template.host` carries `agents_paused`). */
  readonly changed?: (templateId: string) => void;
}

/** The waits of every template. */
export class TemplatePause {
  readonly #deps: TemplatePauseDeps;
  readonly #state = new Map<string, PauseState>();

  constructor(deps: TemplatePauseDeps) {
    this.#deps = deps;
  }

  /**
   * A sign-in window opened; agents wait unless `released` (the urgent override at start). A window
   * opening on a template with no other live window starts a fresh pause: an override given for an
   * earlier window never carries over.
   */
  open(templateId: string, sessionId: string, released = false): void {
    const was = this.paused(templateId);
    const state = this.#live(templateId) ?? { windows: new Set<string>(), released: false };
    if (state.windows.size === 0) state.released = false;
    state.windows.add(sessionId);
    if (released) state.released = true;
    this.#state.set(templateId, state);
    if (was !== this.paused(templateId)) this.#deps.changed?.(templateId);
  }

  /** A sign-in window closed. */
  close(templateId: string, sessionId: string): void {
    const state = this.#state.get(templateId);
    if (state === undefined) return;
    const was = this.paused(templateId);
    state.windows.delete(sessionId);
    if (state.windows.size === 0) this.#state.delete(templateId);
    if (was !== this.paused(templateId)) this.#deps.changed?.(templateId);
  }

  /**
   * **Let agents continue**: the template's waits end until its windows close. False when it was
   * not paused (pressing it twice is harmless).
   */
  release(templateId: string): boolean {
    if (!this.paused(templateId)) return false;
    const state = this.#state.get(templateId);
    if (state === undefined) return false;
    state.released = true;
    this.#deps.changed?.(templateId);
    return true;
  }

  /** Agents of the template wait now. */
  paused(templateId: string): boolean {
    const state = this.#live(templateId);
    return state !== null && !state.released;
  }

  /** The template's state with dead windows dropped; `null` (and forgotten) when none is left. */
  #live(templateId: string): PauseState | null {
    const state = this.#state.get(templateId);
    if (state === undefined) return null;
    for (const id of [...state.windows]) if (!this.#deps.alive(id)) state.windows.delete(id);
    if (state.windows.size > 0) return state;
    this.#state.delete(templateId);
    // A window that died ended the pause: publish it after this read returns.
    const changed = this.#deps.changed;
    if (changed !== undefined && !state.released) queueMicrotask(() => changed(templateId));
    return null;
  }

  /**
   * Waits while the template is paused, at most `maxMs`.
   *
   * @throws AppError `TEMPLATE_UNAVAILABLE` (`reason: 'paused'`) when the wait runs out or `signal`
   *   aborts while still paused.
   */
  async wait(
    templateId: string,
    name: string,
    signal?: AbortSignal,
    maxMs: number = PAUSE_WAIT_MS,
  ): Promise<void> {
    if (!this.paused(templateId)) return;
    const { clock } = this.#deps;
    const until = clock.now() + maxMs;
    while (this.paused(templateId)) {
      const left = until - clock.now();
      if (left <= 0 || signal?.aborted === true) {
        throw templateUnavailable(name, 'paused', PAUSE_RETRY_AFTER_MS);
      }
      await clock.sleep(Math.min(PAUSE_POLL_MS, left));
    }
  }
}

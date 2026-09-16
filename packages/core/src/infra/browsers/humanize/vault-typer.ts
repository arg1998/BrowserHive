/** @module infra/browsers/humanize/vault-typer — the bridge between the vault broker and the humanize layer (system RNG, fill fallback). */

/**
 * The broker deliberately knows nothing about humanization — it drives a deliberately tiny
 * {@link VaultTyperPage} surface so its unit tests can use a hand-written double. This adapter is what
 * the composition root injects to give it human keystroke cadence without that dependency: it
 * narrows the page structurally at call time and falls back to `fill` whenever the real thing is not
 * there.
 *
 * **Falling back rather than throwing is the whole contract.** A credential fill is the worst place
 * in the system to fail over presentation: the redaction window is already armed, the page is already
 * primed, and a thrown error becomes an `auth_failed` that looks like a broken login. Slower typing is
 * a nice-to-have; entering the credential is not.
 */

import { sleep as defaultSleep, type Sleep } from './clock.ts';
import { type Rng, systemRng } from './rng.ts';
import { performTyping, planTyping, type TypingKeyboard } from './typing.ts';

/** The minimal page surface the vault broker drives: it can `fill` a selector. */
export interface VaultTyperPage {
  fill(selector: string, value: string, options?: { timeout?: number }): Promise<void>;
}

/** Per-field options the broker passes to the typer. */
export interface VaultTyperOptions {
  /** Field-entry ceiling in ms (the broker's 30 000 ms constant, spec 11 §3). */
  readonly timeoutMs: number;
}

/** The function the vault broker injects to enter one credential value into one field. */
export type HumanTyper = (
  page: VaultTyperPage,
  selector: string,
  value: string,
  options: VaultTyperOptions,
) => Promise<void>;

/** A page that can actually be typed into: it has a keyboard and can focus a selector. */
interface TypeablePage extends VaultTyperPage {
  readonly keyboard: TypingKeyboard;
  focus(selector: string, options?: { timeout?: number }): Promise<void>;
}

/** Whether this page exposes the keyboard + focus pair the humanized path needs. */
function isTypeable(page: VaultTyperPage): page is TypeablePage {
  const candidate: Partial<TypeablePage> = page;
  return (
    typeof candidate.focus === 'function' &&
    typeof candidate.keyboard?.type === 'function' &&
    typeof candidate.keyboard?.press === 'function'
  );
}

/** Dependencies of {@link createVaultHumanTyper}; both default to production values. */
export interface VaultHumanTyperDeps {
  /** Defaults to system randomness (see the factory doc). */
  readonly rng?: Rng;
  /** Defaults to the module sleep; production passes `clock.sleep`. */
  readonly sleep?: Sleep;
}

/**
 * Build the {@link HumanTyper} the vault broker injects.
 *
 * `rng` defaults to system randomness rather than a seeded stream: unlike pointer paths — where one
 * session should read as one consistent hand — there is no benefit to a credential being typed with
 * a reproducible rhythm, and some benefit to it not being.
 */
export function createVaultHumanTyper(deps: VaultHumanTyperDeps = {}): HumanTyper {
  const rng = deps.rng ?? systemRng();
  const sleep = deps.sleep ?? defaultSleep;
  return async (page, selector, value, options) => {
    if (!isTypeable(page)) {
      await page.fill(selector, value, { timeout: options.timeoutMs });
      return;
    }
    await page.focus(selector, { timeout: options.timeoutMs });
    // Fit the plan to the field's own budget so a long passphrase cannot outlast the fill's timeout.
    const plan = planTyping(value, rng, {}, options.timeoutMs * 0.8);
    await performTyping(page.keyboard, plan, sleep);
  };
}

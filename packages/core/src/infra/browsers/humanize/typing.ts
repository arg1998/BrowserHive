/** @module infra/browsers/humanize/typing — humanized keystroke cadence: log-normal intervals, word/sentence pauses, corrected typos. */

/**
 * Neither reference humanizer (`ghost-cursor`, `ghost-cursor-playwright`) touches typing at all, so
 * this model is ours. What it reproduces, and why each part is there:
 *
 *   - **Log-normal inter-key intervals.** Human keystroke timing is right-skewed with a heavy tail —
 *     mostly fast, occasionally much slower — which is exactly a log-normal. A uniform jitter band
 *     (or Playwright's constant `delay`) has the wrong *shape*, and shape is what a keystroke-dynamics
 *     classifier reads.
 *   - **Burst-and-pause structure.** People type inside a word and pause between them; a longer pause
 *     lands after sentence punctuation. Flat inter-key timing across a whole string is a tell no
 *     amount of per-key jitter hides.
 *   - **Occasional typo + correction.** A small rate of adjacent-key errors, each followed by a
 *     realisation pause, a `Backspace`, and a retype. Perfect input over a long string is itself
 *     anomalous.
 *
 * The plan is built **purely** ({@link planTyping}) and executed separately ({@link performTyping}),
 * so every timing decision is unit-testable without a browser and without a clock.
 *
 * **Containment note:** `vault_fill` types credentials through this module. The plan is a list of
 * literal text fragments, so a credential does appear in the plan — it is built, consumed, and
 * dropped inside the caller's stack frame, never logged, returned, or stored. The vault's redaction
 * window is armed *before* typing begins, so a character-by-character echo is covered.
 */

import { chance, clamp, logNormal, pick, type Rng, uniform } from './rng.ts';

/** One step of a typing plan: emit `text`, or press a named key, after waiting `delayMs`. */
export type TypingAction =
  | { readonly kind: 'text'; readonly text: string; readonly delayMs: number }
  | { readonly kind: 'key'; readonly key: string; readonly delayMs: number };

/** Tunables of the keystroke model. Production never overrides them. */
export interface TypingOptions {
  /** Median inter-key interval (ms). The log-normal's `mu` is `ln` of this. */
  readonly medianIntervalMs: number;
  /** Spread of the inter-key log-normal. Larger ⇒ a heavier tail of slow keystrokes. */
  readonly sigma: number;
  /** Extra median pause (ms) after a word boundary, on top of the normal interval. */
  readonly wordPauseMs: number;
  /** Extra median pause (ms) after sentence-ending punctuation. */
  readonly sentencePauseMs: number;
  /** Probability that any given character is mistyped and then corrected. */
  readonly typoRate: number;
  /** Bounds (ms) on the "realisation" pause between a typo and the `Backspace`. */
  readonly typoNoticeMs: { readonly min: number; readonly max: number };
  /** Hard floor/ceiling (ms) on any single interval, so no draw from the tail is absurd. */
  readonly intervalBounds: { readonly min: number; readonly max: number };
}

/** The keystroke constants (spec 02 §7); pinned by tests so the typing rhythm stays stable. */
export const DEFAULT_TYPING_OPTIONS: TypingOptions = {
  medianIntervalMs: 130,
  sigma: 0.38,
  wordPauseMs: 90,
  sentencePauseMs: 260,
  typoRate: 0.03,
  typoNoticeMs: { min: 120, max: 380 },
  intervalBounds: { min: 25, max: 900 },
};

/**
 * QWERTY physical neighbours, used to pick a *plausible* wrong key. A typo that lands on a key across
 * the board is not a typo, it is noise — the correction only reads as human if the error does.
 */
const QWERTY_NEIGHBOURS: Readonly<Record<string, string>> = {
  a: 'qwsz',
  b: 'vghn',
  c: 'xdfv',
  d: 'serfcx',
  e: 'wsdr',
  f: 'drtgvc',
  g: 'ftyhbv',
  h: 'gyujnb',
  i: 'ujko',
  j: 'huikmn',
  k: 'jiolm',
  l: 'kop',
  m: 'njk',
  n: 'bhjm',
  o: 'iklp',
  p: 'ol',
  q: 'wa',
  r: 'edft',
  s: 'awedxz',
  t: 'rfgy',
  u: 'yhji',
  v: 'cfgb',
  w: 'qase',
  x: 'zsdc',
  y: 'tghu',
  z: 'asx',
  '1': '2q',
  '2': '13w',
  '3': '24e',
  '4': '35r',
  '5': '46t',
  '6': '57y',
  '7': '68u',
  '8': '79i',
  '9': '80o',
  '0': '9p',
};

/**
 * A plausible mistyped character for `ch`, preserving case, or `undefined` when the character has no
 * modelled neighbour (punctuation, non-Latin scripts, anything we would only guess at).
 */
export function neighbourKey(ch: string, rng: Rng): string | undefined {
  const neighbours = QWERTY_NEIGHBOURS[ch.toLowerCase()];
  if (neighbours === undefined || neighbours.length === 0) return undefined;
  const wrong = pick(rng, [...neighbours]);
  return ch === ch.toUpperCase() && ch !== ch.toLowerCase() ? wrong.toUpperCase() : wrong;
}

/** Characters after which a human noticeably pauses. */
const SENTENCE_END: ReadonlySet<string> = new Set(['.', '!', '?', ',', ';', ':']);

/**
 * Build the timed action plan for typing `text`.
 *
 * `budgetMs`, when given, caps the plan's total duration: if the natural cadence would exceed it,
 * every delay is scaled down by a single factor. This exists because a long string at human speed can
 * outlive a tool's timeout — a uniformly faster typist is a far better failure mode than a tool call
 * that dies halfway through a password field.
 */
export function planTyping(
  text: string,
  rng: Rng,
  overrides: Partial<TypingOptions> = {},
  budgetMs?: number,
): TypingAction[] {
  const options = { ...DEFAULT_TYPING_OPTIONS, ...overrides };
  const mu = Math.log(Math.max(1, options.medianIntervalMs));
  const interval = (): number =>
    Math.round(
      clamp(
        logNormal(rng, mu, options.sigma),
        options.intervalBounds.min,
        options.intervalBounds.max,
      ),
    );

  const actions: TypingAction[] = [];
  const characters = [...text];
  for (let i = 0; i < characters.length; i++) {
    const ch = characters[i];
    if (ch === undefined) continue;

    // A typo: emit a neighbouring key, notice it, backspace, then fall through to the real character.
    if (chance(rng, options.typoRate)) {
      const wrong = neighbourKey(ch, rng);
      if (wrong !== undefined) {
        actions.push({ kind: 'text', text: wrong, delayMs: i === 0 ? 0 : interval() });
        actions.push({
          kind: 'key',
          key: 'Backspace',
          delayMs: Math.round(uniform(rng, options.typoNoticeMs.min, options.typoNoticeMs.max)),
        });
        actions.push({ kind: 'text', text: ch, delayMs: interval() });
        continue;
      }
    }

    let delay = i === 0 ? 0 : interval();
    // The pause belongs *after* the boundary character, i.e. before the character that follows it.
    const previous = i > 0 ? characters[i - 1] : undefined;
    if (previous === ' ') delay += Math.round(logNormal(rng, Math.log(options.wordPauseMs), 0.5));
    else if (previous !== undefined && SENTENCE_END.has(previous)) {
      delay += Math.round(logNormal(rng, Math.log(options.sentencePauseMs), 0.5));
    }
    actions.push({ kind: 'text', text: ch, delayMs: delay });
  }

  return budgetMs === undefined ? actions : fitToBudget(actions, budgetMs);
}

/**
 * Scale every delay by one factor so the plan fits `budgetMs`. A uniform scale is deliberate: it
 * compresses the cadence while preserving the *relative* structure (bursts, pauses, the typo
 * realisation gap), which is the part a classifier reads.
 */
export function fitToBudget(actions: readonly TypingAction[], budgetMs: number): TypingAction[] {
  const total = actions.reduce((sum, action) => sum + action.delayMs, 0);
  if (total <= budgetMs || total === 0) return [...actions];
  const scale = budgetMs / total;
  return actions.map((action) => ({ ...action, delayMs: Math.round(action.delayMs * scale) }));
}

/** Total wall-clock duration a plan will take, excluding the driver's own per-key cost. */
export function planDuration(actions: readonly TypingAction[]): number {
  return actions.reduce((sum, action) => sum + action.delayMs, 0);
}

/** The minimal keyboard surface {@link performTyping} drives. A subset of Playwright's `Keyboard`. */
export interface TypingKeyboard {
  type(text: string): Promise<void>;
  press(key: string): Promise<void>;
}

/**
 * Execute a plan against a keyboard, sleeping each action's declared delay first.
 *
 * Each character goes through `keyboard.type()` rather than `keyboard.press()` so that arbitrary text
 * — accents, symbols, non-Latin scripts — is entered correctly; `press` takes key *names* and would
 * mangle anything outside the modelled keyboard layout. The cost is that key **dwell** (down-to-up
 * time) is whatever the driver emits rather than something we shape; inter-key interval is the far
 * stronger signal and it is fully ours.
 */
export async function performTyping(
  keyboard: TypingKeyboard,
  actions: readonly TypingAction[],
  sleep: (ms: number) => Promise<void>,
  onAction?: (completed: number, total: number) => void,
): Promise<void> {
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    if (action === undefined) continue;
    if (action.delayMs > 0) await sleep(action.delayMs);
    if (action.kind === 'text') await keyboard.type(action.text);
    else await keyboard.press(action.key);
    onAction?.(i + 1, actions.length);
  }
}

/** @module domain/vault/page-actions — page-level helpers of the fill: fill-target gate (D-58), form-action defence, best-effort clear, safe url read. */

import { checkOrigin } from './origin.ts';
import type { VaultFillRequest, VaultPage } from './types.ts';

/**
 * Form-action mutation defence: the `action` of the form owning the password field, when a
 * concrete cross-origin http(s) URL, means the form was rewired to exfiltrate. No action,
 * same-page/relative/`javascript:` actions, or a page without `$eval` pass through.
 */
export async function formActionAllowed(
  page: VaultPage,
  passwordSelector: string,
  allowedOrigins: readonly string[],
): Promise<boolean> {
  if (typeof page.$eval !== 'function') return true;
  let action: string | null;
  try {
    action = await page.$eval(passwordSelector, (el) => {
      // Runs in the browser: no closures, no DOM types; walk the shape defensively.
      if (typeof el !== 'object' || el === null || !('form' in el)) return null;
      const form = el.form;
      if (typeof form !== 'object' || form === null || !('action' in form)) return null;
      return typeof form.action === 'string' ? form.action : null;
    });
  } catch {
    return true;
  }
  if (action === null || action.length === 0) return true;
  const check = checkOrigin(action, allowedOrigins);
  if (check.outcome === 'pass') return true;
  return check.reason === 'bad_scheme' || check.reason === 'no_host';
}

/** What the page reports about one element a vault selector matched (computed in the page). */
export interface FieldFacts {
  /** An HTML `<input>` element (not a `textarea`, a `contenteditable` or anything else). */
  readonly input: boolean;
  /** The normalised `type` property (`''` when not an input). */
  readonly type: string;
  /** `:disabled`, including through a disabled `<fieldset>`. */
  readonly disabled: boolean;
  readonly readOnly: boolean;
  /** A non-empty box and not `visibility: hidden` (Playwright's notion of visible). */
  readonly visible: boolean;
}

/** Why a selector is not an acceptable fill target. Audit detail only; the agent sees one reason. */
export type FillTargetProblem =
  | 'no_match'
  | 'multiple_matches'
  | 'not_password_input'
  | 'not_text_input'
  | 'disabled'
  | 'readonly'
  | 'hidden'
  | 'unverifiable';

/** A refused fill target: which field and why. */
export interface FillTargetRefusal {
  readonly field: 'username' | 'password';
  readonly problem: FillTargetProblem;
}

/** `<input>` types that never take a typed username (D-58). */
const NON_TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  'password',
  'hidden',
  'file',
  'checkbox',
  'radio',
  'submit',
  'button',
  'image',
  'reset',
]);

/**
 * Runs inside the page against every matched element. Self-contained (Playwright serialises it):
 * no closures and no DOM types, so it walks the shape defensively like `formActionAllowed`.
 */
function describeMatches(els: unknown[]): FieldFacts[] {
  return els.map((el) => {
    const none = { input: false, type: '', disabled: false, readOnly: false, visible: false };
    if (typeof el !== 'object' || el === null) return none;
    const input =
      'localName' in el &&
      el.localName === 'input' &&
      'namespaceURI' in el &&
      el.namespaceURI === 'http://www.w3.org/1999/xhtml';
    const type = input && 'type' in el && typeof el.type === 'string' ? el.type.toLowerCase() : '';
    const disabled =
      ('disabled' in el && el.disabled === true) ||
      ('matches' in el && typeof el.matches === 'function' && el.matches(':disabled') === true);
    const readOnly = 'readOnly' in el && el.readOnly === true;
    let visible = false;
    if ('getBoundingClientRect' in el && typeof el.getBoundingClientRect === 'function') {
      const rect: unknown = el.getBoundingClientRect();
      visible =
        typeof rect === 'object' &&
        rect !== null &&
        'width' in rect &&
        'height' in rect &&
        typeof rect.width === 'number' &&
        typeof rect.height === 'number' &&
        rect.width > 0 &&
        rect.height > 0;
    }
    if (visible && 'checkVisibility' in el && typeof el.checkVisibility === 'function') {
      visible = el.checkVisibility({ visibilityProperty: true }) === true;
    }
    return { input, type, disabled, readOnly, visible };
  });
}

function isFieldFacts(value: unknown): value is FieldFacts {
  return (
    typeof value === 'object' &&
    value !== null &&
    'input' in value &&
    typeof value.input === 'boolean' &&
    'type' in value &&
    typeof value.type === 'string' &&
    'disabled' in value &&
    typeof value.disabled === 'boolean' &&
    'readOnly' in value &&
    typeof value.readOnly === 'boolean' &&
    'visible' in value &&
    typeof value.visible === 'boolean'
  );
}

/**
 * The facts of every element `selector` matches, or `null` when the page cannot answer (no
 * `$$eval`, a selector the engine rejects, a page that navigated away, a malformed answer).
 */
export async function inspectTarget(
  page: VaultPage,
  selector: string,
): Promise<readonly FieldFacts[] | null> {
  if (typeof page.$$eval !== 'function') return null;
  let facts: unknown;
  try {
    facts = await page.$$eval(selector, describeMatches);
  } catch {
    return null;
  }
  if (!Array.isArray(facts) || !facts.every(isFieldFacts)) return null;
  return facts;
}

/** The password target must be exactly one visible, enabled, writable `<input type="password">`. */
export function passwordTargetProblem(facts: readonly FieldFacts[]): FillTargetProblem | null {
  const [only, ...rest] = facts;
  if (only === undefined) return 'no_match';
  if (rest.length > 0) return 'multiple_matches';
  if (!only.input || only.type !== 'password') return 'not_password_input';
  if (only.disabled) return 'disabled';
  if (only.readOnly) return 'readonly';
  if (!only.visible) return 'hidden';
  return null;
}

/** The username target must be exactly one `<input>` whose type takes typed text. */
export function usernameTargetProblem(facts: readonly FieldFacts[]): FillTargetProblem | null {
  const [only, ...rest] = facts;
  if (only === undefined) return 'no_match';
  if (rest.length > 0) return 'multiple_matches';
  if (!only.input || NON_TEXT_INPUT_TYPES.has(only.type)) return 'not_text_input';
  return null;
}

/**
 * How the username target is judged: `required` when a username is about to be typed;
 * `if_present` before the credential is fetched (whether the entry has a username is not known
 * yet, so a selector that matches nothing is left to the pre-entry check, which runs only when a
 * username will be typed); `skip` when only the password is about to be typed.
 */
export type UsernameTargetMode = 'required' | 'if_present' | 'skip';

/**
 * The fill-target gate (D-58, spec 13 T0e): the password selector must name exactly one password
 * input and the username selector exactly one text-like input, so the agent cannot direct the
 * credential into a field it can read back (a search box, a `textarea`, a `contenteditable`).
 * Returns the refusal, or `null` when the targets are acceptable.
 *
 * It FAILS CLOSED: a page that cannot be inspected (no `$$eval`, an evaluation error) refuses the
 * fill. `formActionAllowed` fails open on purpose and this gate must not: the form-action check
 * guards against the page rewiring its own form, after the origin gate has already vouched for
 * that page, so "could not tell" there leaves a fill the operator authorized; this gate guards
 * against the *agent's* selector, and the action it would let through is writing the secret into
 * an element the agent chose, so "could not tell" must mean "do not type".
 */
export async function fillTargetRefusal(
  page: VaultPage,
  request: Pick<VaultFillRequest, 'usernameSelector' | 'passwordSelector'>,
  username: UsernameTargetMode,
): Promise<FillTargetRefusal | null> {
  const password = await inspectTarget(page, request.passwordSelector);
  if (password === null) return { field: 'password', problem: 'unverifiable' };
  const passwordProblem = passwordTargetProblem(password);
  if (passwordProblem !== null) return { field: 'password', problem: passwordProblem };
  if (username === 'skip') return null;
  const user = await inspectTarget(page, request.usernameSelector);
  if (user === null) return { field: 'username', problem: 'unverifiable' };
  if (username === 'if_present' && user.length === 0) return null;
  const userProblem = usernameTargetProblem(user);
  return userProblem === null ? null : { field: 'username', problem: userProblem };
}

/** Best-effort clear of the filled inputs; the page may have navigated. */
export async function clearInputs(page: VaultPage, request: VaultFillRequest): Promise<void> {
  await page.fill(request.passwordSelector, '', { timeout: 1000 }).catch(() => undefined);
  await page.fill(request.usernameSelector, '', { timeout: 1000 }).catch(() => undefined);
}

/** `page.url()` or `''` when the page is gone. */
export function safeUrl(page: VaultPage): string {
  try {
    return page.url();
  } catch {
    return '';
  }
}

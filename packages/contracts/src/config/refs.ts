/** @module contracts/config/refs — `{env:NAME}` references inside config-file strings: the one-pass scanner, expansion against an injected lookup, and the safe renderings used in messages (spec 08 §3.1, D-29). Pure: no I/O, no `process`. */

/** Reference schemes the resolver understands. Grows by addition only; `cmd` is refused permanently (D-29). */
export const REF_SCHEMES = ['env'] as const;
/** Union of {@link REF_SCHEMES}. */
export type RefScheme = (typeof REF_SCHEMES)[number];

/** The supported forms, as problem messages and help list them. */
export const REF_FORMS = '{env:NAME}, {env:NAME:-default}';

/** One reference resolved inside a supplied value. The name is safe to show; the value is not. */
export interface ValueRef {
  /** Reference scheme (today always `env`). */
  readonly scheme: RefScheme;
  /** The variable name as written, without any default (`OTLP_TOKEN`). */
  readonly ref: string;
  /** Whether the variable supplied the text, or the `:-` default did. */
  readonly from: 'value' | 'default';
  /** Position inside an array or object value (`[0]`, `Authorization`, `modules.sessions`); absent for a plain string. */
  readonly at?: string;
}

/** One piece of a scanned string. `text` is exactly what was written. */
export type RefToken =
  /** Text that is not a reference (an escape `{{x:y}}` contributes its unescaped form). */
  | { readonly kind: 'literal'; readonly text: string }
  /** A well-formed `{env:NAME}` or `{env:NAME:-default}`. */
  | {
      readonly kind: 'ref';
      readonly text: string;
      readonly scheme: RefScheme;
      readonly name: string;
      /** The `:-` default; `undefined` when the reference has none (it is required). */
      readonly fallback: string | undefined;
    }
  /** `{env:` that does not form a valid reference. Scanning stops here; the rest of the string follows as one literal token. */
  | { readonly kind: 'malformed'; readonly text: string }
  /** `{word:text}` whose word is not a supported scheme (`{file:x}`, `{ENV:X}`). */
  | { readonly kind: 'unknown-scheme'; readonly text: string; readonly scheme: string }
  /** `${env:…}`: the Collector's spelling, one `$` too many. */
  | { readonly kind: 'dollar'; readonly text: string; readonly body: string };

const WORD = '[A-Za-z][A-Za-z0-9]*';
/** Kept apart so `${…}` in messages is never mistaken for a template placeholder. */
const DOLLAR = '$';
/** `{{word:text}}` at the scan position. */
const ESCAPE_RE = new RegExp(`^\\{\\{(${WORD}):([^{}]*)\\}\\}`);
/** A whole `{word:text}` at the scan position. */
const SHAPE_RE = new RegExp(`^\\{(${WORD}):([^{}]*)\\}`);
/** `{word:` at the scan position. */
const OPENING_RE = new RegExp(`^\\{(${WORD}):`);
/** The body of an `env` reference: a name and an optional default of printable ASCII without braces. */
const ENV_BODY_RE = /^([A-Za-z_][A-Za-z0-9_]*)(?::-([\x20-\x7A\x7C\x7E]*))?$/;

function isScheme(word: string): word is RefScheme {
  return (REF_SCHEMES as readonly string[]).includes(word);
}

/** The text of a malformed `{env:…}` for messages: up to and including the next `}`, else to the end. */
function malformedText(rest: string): string {
  const close = rest.indexOf('}');
  return close < 0 ? rest : rest.slice(0, close + 1);
}

/**
 * Scan a config-file string once, left to right (spec 08 §3.1). `{{word:text}}` is an escape;
 * `{env:` always starts a reference and must be well formed; any other `{word:text}` is an unknown
 * scheme; `${env:…}` is flagged; any other `${word:…}` and every other brace is literal. Nothing is
 * resolved here, and resolved text is never scanned (the caller never feeds it back).
 *
 * @returns The tokens in order; adjacent literal text is merged.
 */
export function scanRefs(text: string): readonly RefToken[] {
  const tokens: RefToken[] = [];
  let literal = '';
  const flush = (): void => {
    if (literal !== '') tokens.push({ kind: 'literal', text: literal });
    literal = '';
  };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    const char = text[i];
    if (char === '$' && rest.startsWith('${')) {
      const shape = SHAPE_RE.exec(rest.slice(1));
      if (shape !== null) {
        const whole = `$${shape[0]}`;
        if ((shape[1] ?? '').toLowerCase() === 'env') {
          flush();
          tokens.push({ kind: 'dollar', text: whole, body: shape[2] ?? '' });
        } else {
          literal += whole; // another tool's syntax (`${var:format}`, `${VAR:-x}`): not ours
        }
        i += whole.length;
        continue;
      }
    }
    if (char === '{') {
      const escaped = ESCAPE_RE.exec(rest);
      if (escaped !== null) {
        literal += escaped[0].slice(1, -1);
        i += escaped[0].length;
        continue;
      }
      const opening = OPENING_RE.exec(rest);
      if (opening !== null) {
        const word = opening[1] ?? '';
        const shape = SHAPE_RE.exec(rest);
        if (isScheme(word)) {
          const body = shape === null ? null : ENV_BODY_RE.exec(shape[2] ?? '');
          if (shape === null || body === null) {
            flush();
            const bad = malformedText(rest);
            tokens.push({ kind: 'malformed', text: bad });
            const after = text.slice(i + bad.length);
            if (after !== '') tokens.push({ kind: 'literal', text: after });
            return tokens;
          }
          flush();
          tokens.push({
            kind: 'ref',
            text: shape[0],
            scheme: word,
            name: body[1] ?? '',
            fallback: body[2],
          });
          i += shape[0].length;
          continue;
        }
        if (shape !== null) {
          flush();
          tokens.push({ kind: 'unknown-scheme', text: shape[0], scheme: word });
          i += shape[0].length;
          continue;
        }
      }
    }
    literal += char;
    i += 1;
  }
  flush();
  return tokens;
}

/** A problem found while expanding one string (rendered into messages by the resolver). */
export type RefProblem =
  | { readonly kind: 'unset' | 'empty'; readonly token: Extract<RefToken, { kind: 'ref' }> }
  | { readonly kind: 'malformed'; readonly token: Extract<RefToken, { kind: 'malformed' }> }
  | {
      readonly kind: 'unknown-scheme';
      readonly token: Extract<RefToken, { kind: 'unknown-scheme' }>;
    }
  | { readonly kind: 'dollar'; readonly token: Extract<RefToken, { kind: 'dollar' }> };

/** Result of {@link expandRefs}. */
export interface Expansion {
  /** The expanded text (meaningless when `problems` is non-empty). */
  readonly value: string;
  /** Every reference that resolved, in source order. */
  readonly refs: readonly ValueRef[];
  /** The values the references produced, parallel to `refs` (never rendered; for the secret registry). */
  readonly values: readonly string[];
  readonly problems: readonly RefProblem[];
}

/** Looks a variable up in the injected environment; `undefined` when unset. */
export type EnvLookup = (name: string) => string | undefined;

/**
 * Expand every reference in one string against `lookup` (spec 08 §3.1). `{env:NAME}` needs `NAME`
 * set and non-empty; `{env:NAME:-text}` falls back to `text` when it is unset or empty. Every problem
 * in the string is collected (up to the first malformed reference, where scanning stops).
 *
 * @returns The expanded value, the references with their origin, and the problems.
 */
export function expandRefs(text: string, lookup: EnvLookup): Expansion {
  let value = '';
  const refs: ValueRef[] = [];
  const values: string[] = [];
  const problems: RefProblem[] = [];
  for (const token of scanRefs(text)) {
    switch (token.kind) {
      case 'literal':
        value += token.text;
        break;
      case 'ref': {
        const found = lookup(token.name);
        if (found !== undefined && found !== '') {
          value += found;
          refs.push({ scheme: token.scheme, ref: token.name, from: 'value' });
          values.push(found);
        } else if (token.fallback !== undefined) {
          value += token.fallback;
          refs.push({ scheme: token.scheme, ref: token.name, from: 'default' });
          values.push(token.fallback);
        } else {
          problems.push({ kind: found === undefined ? 'unset' : 'empty', token });
        }
        break;
      }
      case 'malformed':
        problems.push({ kind: 'malformed', token });
        break;
      case 'unknown-scheme':
        problems.push({ kind: 'unknown-scheme', token });
        break;
      case 'dollar':
        problems.push({ kind: 'dollar', token });
        break;
    }
  }
  return { value, refs, values, problems };
}

/**
 * How a reference token reads in a message. For a secret key only names are shown: a default's text
 * becomes `…` and any other body is hidden, so the file's text never reaches stderr (spec 08 §3.1).
 *
 * @returns `{env:NAME}`, `{env:NAME:-…}` or the token as written.
 */
export function refTokenText(token: RefToken, secret: boolean): string {
  if (!secret) return token.text;
  switch (token.kind) {
    case 'ref':
      return `{${token.scheme}:${token.name}${token.fallback === undefined ? '' : ':-…'}}`;
    case 'dollar': {
      const body = ENV_BODY_RE.exec(token.body);
      const name = body === null ? '…' : `${body[1] ?? ''}${body[2] === undefined ? '' : ':-…'}`;
      return `${DOLLAR}{env:${name}}`;
    }
    case 'unknown-scheme':
      return `{${token.scheme}:…}`;
    default:
      return '{env:…}';
  }
}

/**
 * The first reference-like text in a value that is not expanded (env, `OTEL_*`, a flag, an option),
 * for the "references are expanded only in browserhive.config.json" warning. Unknown schemes are
 * ignored there: `{word:text}` was never a reference outside the config file.
 *
 * @returns The token, or `undefined`.
 */
export function firstRefLike(text: string): RefToken | undefined {
  if (!text.includes('{')) return undefined;
  return scanRefs(text).find(
    (token) => token.kind === 'ref' || token.kind === 'dollar' || token.kind === 'malformed',
  );
}

/**
 * The variable list of a provenance record: `$A, $B (default)` (first occurrence order, no repeats).
 *
 * @returns The names, or `''` when there are none.
 */
export function formatRefNames(refs: readonly ValueRef[] | undefined): string {
  if (refs === undefined || refs.length === 0) return '';
  const seen = new Map<string, ValueRef['from']>();
  for (const ref of refs) if (!seen.has(ref.ref)) seen.set(ref.ref, ref.from);
  return [...seen]
    .map(([name, from]) => `$${name}${from === 'default' ? ' (default)' : ''}`)
    .join(', ');
}

/**
 * Pattern of a string holding at least one `{env:NAME}` / `{env:NAME:-default}` reference, for the
 * generated JSON Schema (`$defs.configRef`); unanchored, so a reference inside longer text matches.
 */
export const CONFIG_REF_PATTERN = '\\{env:[A-Za-z_][A-Za-z0-9_]*(:-[^{}]*)?\\}';

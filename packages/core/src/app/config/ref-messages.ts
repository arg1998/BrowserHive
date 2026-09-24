/** @module app/config/ref-messages — the texts of every reference problem and warning (spec 08 §3.1, §4). On a secret key only names are shown, never the file's text. */
import {
  REF_FORMS,
  REF_SCHEMES,
  type RefProblem,
  type RefToken,
  refTokenText,
  type ValueRef,
} from '@browserhive/contracts/config';

const MALFORMED_EXPECTED =
  'Expected {env:NAME} or {env:NAME:-default}, where NAME matches [A-Za-z_][A-Za-z0-9_]* and the default contains no braces.';

function isSchemeWord(word: string): boolean {
  return (REF_SCHEMES as readonly string[]).includes(word.toLowerCase());
}

/**
 * The message of one reference problem in a config-file value, without the `browserhive: ` prefix.
 *
 * @returns The sentence(s) of spec 08 §4.
 */
export function refProblemMessage(
  key: string,
  filePath: string,
  problem: RefProblem,
  secret: boolean,
): string {
  const where = `'${key}' in ${filePath}`;
  switch (problem.kind) {
    case 'unset':
    case 'empty': {
      const name = problem.token.name;
      const state =
        problem.kind === 'unset' ? 'is not set. Set it' : 'is set and empty. Set it to a value';
      return `${where} references ${refTokenText(problem.token, secret)}, but ${name} ${state}, or write a default as {env:${name}:-<value>}.`;
    }
    case 'malformed':
      return secret
        ? `${where} contains a reference that is not valid. ${MALFORMED_EXPECTED}`
        : `${where}: '${problem.token.text}' is not a valid reference. ${MALFORMED_EXPECTED}`;
    case 'unknown-scheme': {
      const { scheme, text } = problem.token;
      const body = text.slice(scheme.length + 2, -1);
      const hint = isSchemeWord(scheme)
        ? ` Did you mean '${secret ? `{${scheme.toLowerCase()}:…}` : `{${scheme.toLowerCase()}:${body}}`}'?`
        : '';
      const head = secret
        ? `${where}: unknown reference scheme '${scheme}'.`
        : `${where}: unknown reference scheme in '${text}'.`;
      const keepLiteral = secret
        ? 'To keep the text literal, double its braces: {{…}}.'
        : `To keep the text literal, write '{${text}}'.`;
      return `${head}${hint} Supported references: ${REF_FORMS}. ${keepLiteral}`;
    }
    case 'dollar': {
      const shown = refTokenText(problem.token, secret);
      const suggestion = secret ? shown.slice(1) : `{env:${problem.token.body}}`;
      return `${where}: '${shown}' looks like a reference with an extra '$'. Did you mean '${suggestion}'?`;
    }
  }
}

/**
 * The message when a value is empty only after its references resolved: every reference used an empty
 * default (a required reference cannot produce `''`), so they read `{env:NAME:-}`.
 *
 * @returns `'<key>' in <file> is empty after resolving {env:A:-}. Unset it or provide a value.`
 */
export function emptyAfterMessage(
  key: string,
  filePath: string,
  refs: readonly ValueRef[],
): string {
  const names = [...new Set(refs.map((ref) => ref.ref))].map((name) => `{env:${name}:-}`);
  return `'${key}' in ${filePath} is empty after resolving ${names.join(', ')}. Unset it or provide a value.`;
}

/**
 * The clause appended to an invalid-value message whose value came through references.
 *
 * @returns ` (interpolated from {env:A}, {env:B} (default))`, or `''` without references.
 */
export function interpolatedFrom(refs: readonly ValueRef[] | undefined): string {
  if (refs === undefined || refs.length === 0) return '';
  const seen = new Map<string, ValueRef['from']>();
  for (const ref of refs) if (!seen.has(ref.ref)) seen.set(ref.ref, ref.from);
  const names = [...seen].map(
    ([name, from]) => `{env:${name}}${from === 'default' ? ' (default)' : ''}`,
  );
  return ` (interpolated from ${names.join(', ')})`;
}

/**
 * The warning for reference-shaped text in a value that is not expanded (env, `OTEL_*`, a flag or
 * an option).
 *
 * @returns `<location> contains '{env:X}'; references are expanded only in browserhive.config.json.`
 */
export function unexpandedRefWarning(location: string, token: RefToken, secret: boolean): string {
  return `${location} contains '${refTokenText(token, secret)}'; references are expanded only in browserhive.config.json.`;
}

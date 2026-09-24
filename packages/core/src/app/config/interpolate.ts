/** @module app/config/interpolate — expand `{env:NAME}` references in one config-file value: every string leaf, array element and object value, never a key (spec 08 §3.1 and §6 step 2.5, D-29) */
import {
  type EnvLookup,
  expandRefs,
  type RefProblem,
  type ValueRef,
} from '@browserhive/contracts/config';
import type { JsonValue } from './json-parse.ts';

/** One problem, with where it sits inside a structured value. */
export interface LocatedRefProblem {
  readonly problem: RefProblem;
  /** `[0]`, `Authorization`, `modules.sessions`; absent for a plain string. */
  readonly at?: string;
}

/** Result of {@link interpolateJson}. */
export interface InterpolatedJson {
  /** The value with every string expanded (meaningless when `problems` is non-empty). */
  readonly value: JsonValue;
  /** Every reference that resolved, in source order, with `at` inside structured values. */
  readonly refs: readonly ValueRef[];
  /** What each reference produced, parallel to `refs`. Never rendered; only for the secret registry. */
  readonly values: readonly string[];
  readonly problems: readonly LocatedRefProblem[];
}

function childPath(parent: string | undefined, segment: string | number): string {
  if (typeof segment === 'number') return `${parent ?? ''}[${segment}]`;
  return parent === undefined ? segment : `${parent}.${segment}`;
}

function isArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

/**
 * Expand the references in a config-file value, once, against `lookup`: string leaves are scanned,
 * arrays element-wise, objects value-wise (keys are never expanded), numbers, booleans and `null`
 * pass through. Expanded text is never scanned again.
 *
 * @returns The expanded value, the resolved references and every problem.
 */
export function interpolateJson(value: JsonValue, lookup: EnvLookup): InterpolatedJson {
  const refs: ValueRef[] = [];
  const values: string[] = [];
  const problems: LocatedRefProblem[] = [];

  const walk = (node: JsonValue, at: string | undefined): JsonValue => {
    if (typeof node === 'string') {
      const expansion = expandRefs(node, lookup);
      for (const ref of expansion.refs) refs.push(at === undefined ? ref : { ...ref, at });
      values.push(...expansion.values);
      for (const problem of expansion.problems) {
        problems.push(at === undefined ? { problem } : { problem, at });
      }
      return expansion.value;
    }
    if (node === null || typeof node !== 'object') return node;
    if (isArray(node)) return node.map((item, index) => walk(item, childPath(at, index)));
    const out: { [key: string]: JsonValue } = {};
    for (const [key, item] of Object.entries(node)) out[key] = walk(item, childPath(at, key));
    return out;
  };

  return { value: walk(value, undefined), refs, values, problems };
}

/**
 * Look a variable up in the resolver's injected environment. Windows names are case-insensitive, as
 * in the OS; the injected record is a plain copy, so the fallback search does what the OS would.
 *
 * @returns The lookup function.
 */
export function envLookup(
  env: Readonly<Record<string, string | undefined>>,
  platform: string,
): EnvLookup {
  return (name) => {
    const exact = env[name];
    if (exact !== undefined || platform !== 'win32') return exact;
    const upper = name.toUpperCase();
    const match = Object.keys(env).find((candidate) => candidate.toUpperCase() === upper);
    return match === undefined ? undefined : env[match];
  };
}

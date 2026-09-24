/** @module app/config/failure — `ConfigProblem`/`ConfigFailure`: every fail-fast outcome of the resolver with the exit code and the `browserhive: …` rendering of spec 08 §4 */
import type { ProvenanceSource } from '@browserhive/contracts/config';

/** Failure codes the resolver can produce. Registry codes keep their name; the rest are resolver-local. */
export type ConfigFailureCode =
  | 'CONFIG_INVALID'
  | 'CONFIG_UNKNOWN_KEY'
  | 'CONFIG_RESERVED_KEY'
  | 'CONFIG_EMPTY_VALUE'
  | 'CONFIG_REF_UNRESOLVED'
  | 'CONFIG_FILE_INVALID'
  | 'CONFIG_USAGE'
  | 'INSECURE_BIND_REFUSED'
  | 'ADMIN_REQUIRES_HTTP';

/** Where a problem was detected: a config source, the cross-field rules, or a policy guard. */
export type ProblemSource = ProvenanceSource | 'cross-field' | 'policy';

/** One detected problem; the resolver collects all of them before failing. */
export interface ConfigProblem {
  readonly code: ConfigFailureCode;
  /** Canonical key when the problem concerns one. */
  readonly key?: string;
  readonly source: ProblemSource;
  /** `--sessionLease`, `BROWSERHIVE_SESSION_LEASE`, `file:/path#sessionLease`, `options.port`. */
  readonly location: string;
  /** Message text without the `browserhive: ` prefix and without the `[CODE] ` prefix. */
  readonly message: string;
  /** "Did you mean" candidates in the source's own spelling. */
  readonly suggestions?: readonly string[];
}

/** Process exit code of a failure (spec 08 §7.3). */
export type ConfigExitCode = 64 | 3;

/** The error value of a failed `resolveConfig`. */
export interface ConfigFailure {
  /** Code of the first problem (problems are in detection order). */
  readonly code: ConfigFailureCode;
  /** `3` when any problem is a policy refusal, else `64`. */
  readonly exitCode: ConfigExitCode;
  readonly problems: readonly ConfigProblem[];
  /** The stderr text: one `browserhive: …` line per problem. */
  render(): string;
}

const POLICY_CODES: ReadonlySet<ConfigFailureCode> = new Set([
  'INSECURE_BIND_REFUSED',
  'ADMIN_REQUIRES_HTTP',
]);

/**
 * Render one problem as its stderr line: `browserhive: <message>`, or
 * `browserhive: [CODE] <message>` for policy refusals (spec 08 §4, §7.3).
 *
 * @returns The line without a trailing newline.
 */
export function renderProblem(problem: ConfigProblem): string {
  const prefix = POLICY_CODES.has(problem.code) ? `[${problem.code}] ` : '';
  return `browserhive: ${prefix}${problem.message}`;
}

/**
 * Build a {@link ConfigFailure} from collected problems (at least one).
 *
 * @returns The failure with its exit code and renderer.
 */
export function configFailure(problems: readonly ConfigProblem[]): ConfigFailure {
  const first = problems[0];
  const code: ConfigFailureCode = first?.code ?? 'CONFIG_INVALID';
  const exitCode: ConfigExitCode = problems.some((p) => POLICY_CODES.has(p.code)) ? 3 : 64;
  const frozen = Object.freeze([...problems]);
  return {
    code,
    exitCode,
    problems: frozen,
    render: () => frozen.map(renderProblem).join('\n'),
  };
}

/**
 * Append the "did you mean" clause of spec 08 §4 to a message.
 *
 * @returns `` `${message} Did you mean '--maxSessions'?` `` or the message unchanged.
 */
export function withSuggestion(message: string, suggestions: readonly string[]): string {
  if (suggestions.length === 0) return message;
  if (suggestions.length === 1) return `${message} Did you mean '${suggestions[0]}'?`;
  const quoted = suggestions.map((s) => `'${s}'`);
  return `${message} Did you mean ${quoted.slice(0, -1).join(', ')} or ${quoted.at(-1)}?`;
}

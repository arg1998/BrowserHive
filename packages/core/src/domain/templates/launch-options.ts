/** @module domain/templates/launch-options — the launch option rules of a template session (spec 13 §5.3): which `launch_session` arguments are ignored, applied or refused, and the per-session settings that result. */

import { templateFixesOptionText } from '@browserhive/contracts/tools';
import type { TemplateRecord } from '../../ports/persistence/index.ts';
import type { CreateSessionInput } from '../session/create-request.ts';
import type { SessionSealing } from './model.ts';

/**
 * The `context_options` keys a template session applies to its own pages (spec 13 §4); every other
 * key is refused when present, whatever its value. Mirrors contracts'
 * `PER_SESSION_TEMPLATE_CONTEXT_OPTIONS` (asserted by the unit test).
 */
export const PER_SESSION_CONTEXT_OPTIONS = ['viewport', 'extraHTTPHeaders', 'colorScheme'] as const;

/** One refused option, in the `INVALID_ARGUMENTS` issue shape (spec 02 §2.3). */
export interface OptionIssue {
  readonly path: string;
  readonly message: string;
}

/** The context options a template session applies per page (spec 13 §4). */
export interface PerSessionContextOptions {
  readonly viewport?: unknown;
  readonly extraHTTPHeaders?: unknown;
  readonly colorScheme?: unknown;
}

/** What a template launch keeps from the request once the rules ran. */
export interface TemplateLaunchSettings {
  /** As sent, forced `true` while evaluate is sealed (spec 13 §5.4). */
  readonly disableEvaluate: boolean;
  /** As sent (or the template's), `false` when the template's stealth is `off`. */
  readonly humanize: boolean;
  readonly contextOptions: PerSessionContextOptions;
}

/** Outcome of {@link applyTemplateLaunchOptions}. */
export type TemplateLaunchOptionsResult =
  | { readonly ok: true; readonly settings: TemplateLaunchSettings }
  | { readonly ok: false; readonly issues: readonly OptionIssue[] };

function keysOf(value: unknown): readonly string[] {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value)
    : [];
}

function propertyOf(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object'
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined;
}

/** The refusal text of spec 13 §5.3: `template '<name>' fixes <option>; omit it` (contracts owns the wording). */
export function fixedOptionMessage(templateName: string, option: string): string {
  return templateFixesOptionText(templateName, option);
}

/**
 * Applies the option table of spec 13 §5.3 to a `launch_session` request naming `template`:
 *
 * - `channel`, `headless`, `incognito` and `vault_enabled` are ignored (the schema always sends them);
 * - `disable_evaluate` is applied, forced `true` while evaluate is sealed;
 * - `humanize` is applied, collapsing to `false` when the template's stealth is `off`;
 * - `stealth` and `fingerprint` are refused when present and different from the template's;
 * - `persistence_mode` other than `memory`, any `restore_profile`, any `launch_options` key and any
 *   `context_options` key outside {@link PER_SESSION_CONTEXT_OPTIONS} are refused by presence, never
 *   by comparing values, so a refusal never tells whether a guessed value equals the template's.
 *
 * Every offending option is one issue, `path` naming it.
 */
export function applyTemplateLaunchOptions(
  template: TemplateRecord,
  input: CreateSessionInput,
  sealing: SessionSealing,
): TemplateLaunchOptionsResult {
  const issues: OptionIssue[] = [];
  const refuse = (path: string) =>
    issues.push({ path, message: fixedOptionMessage(template.name, path) });

  const templateStealth = template.stealth !== 'off';
  if (input.stealth !== undefined && input.stealth !== templateStealth) refuse('stealth');
  if (input.fingerprint !== undefined && input.fingerprint !== template.fingerprint) {
    refuse('fingerprint');
  }
  if (input.persistenceMode !== undefined && input.persistenceMode !== 'memory') {
    refuse('persistence_mode');
  }
  if (input.restoreProfile !== undefined) refuse('restore_profile');
  for (const key of keysOf(input.launchOptions)) refuse(`launch_options.${key}`);

  const allowed: ReadonlySet<string> = new Set(PER_SESSION_CONTEXT_OPTIONS);
  const contextOptions: Record<string, unknown> = {};
  for (const key of keysOf(input.contextOptions)) {
    if (allowed.has(key)) contextOptions[key] = propertyOf(input.contextOptions, key);
    else refuse(`context_options.${key}`);
  }
  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    settings: {
      disableEvaluate: sealing.forceDisableEvaluate || input.disableEvaluate === true,
      humanize: templateStealth && (input.humanize ?? template.humanize),
      contextOptions,
    },
  };
}

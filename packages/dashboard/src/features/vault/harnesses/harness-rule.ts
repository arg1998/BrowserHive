/** @module features/vault/harnesses/harness-rule — the Harnesses field's model (D-48): which chips to show, list edits (`null` = all harnesses, `[]` = none), custom-name validation, the one-line summary used in tables and headers, and the four warnings */
import {
  HARNESS_LABELS,
  HARNESS_RULE_MAX_ENTRIES,
  HARNESS_SLUGS,
  harnessLabel,
  harnessRuleEntryProblem,
  harnessRuleLookalike,
  isHarnessAllowed,
  isHarnessRuleSlug,
  type KnownHarness,
  OTHER_HARNESS,
  UNKNOWN_HARNESS,
} from '@browserhive/contracts/harness';
import type { VaultHarnessesResponse } from '@browserhive/contracts/http';

/** A rule's harness list: `null` = every harness (the default), `[]` = none. */
export type HarnessList = readonly string[] | null;

/** Harnesses always offered as chips, in this order (the rest sit behind "More harnesses"). */
export const COMMON_HARNESSES: readonly KnownHarness[] = [
  'claude-code',
  'codex',
  'cursor',
  'opencode',
  'gemini-cli',
  'vscode',
  'copilot-cli',
];

/** Known harnesses a chip can name: every slug but the `other` and `unknown` buckets. */
export const PICKABLE_HARNESSES: readonly KnownHarness[] = HARNESS_SLUGS.filter(
  (slug) => slug !== OTHER_HARNESS && slug !== UNKNOWN_HARNESS,
);

/** One known-harness chip. */
export interface HarnessChip {
  readonly slug: KnownHarness;
  readonly label: string;
  readonly selected: boolean;
  /** A session or open connection with this harness was seen on this daemon recently. */
  readonly seen: boolean;
}

/** The known-harness chips, split into the always-visible row and the "More harnesses" rest. */
export interface HarnessChips {
  readonly primary: readonly HarnessChip[];
  readonly more: readonly HarnessChip[];
}

/**
 * Chips for the known harnesses: the common ones, the selected ones and the ones seen recently are
 * always visible (in the table's display order); the rest go behind "More harnesses". `Unknown` is
 * not part of this list: the field renders it last, on its own.
 */
export function harnessChips(list: HarnessList, seen: ReadonlySet<string>): HarnessChips {
  const primary: HarnessChip[] = [];
  const more: HarnessChip[] = [];
  const slugs: readonly KnownHarness[] =
    list?.includes(OTHER_HARNESS) === true
      ? [...PICKABLE_HARNESSES, OTHER_HARNESS]
      : PICKABLE_HARNESSES;
  for (const slug of slugs) {
    const chip: HarnessChip = {
      slug,
      label: HARNESS_LABELS[slug],
      selected: list?.includes(slug) === true,
      seen: seen.has(slug),
    };
    if (COMMON_HARNESSES.includes(slug) || chip.selected || chip.seen) primary.push(chip);
    else more.push(chip);
  }
  return { primary, more };
}

/** Pressing a harness chip: from "all" it starts a list of one; unpressing the last leaves `[]`. */
export function toggleHarness(list: HarnessList, slug: string): string[] {
  if (list === null) return [slug];
  return list.includes(slug) ? list.filter((entry) => entry !== slug) : [...list, slug];
}

/** Custom names in the list (entries that are not a known slug), in list order. */
export function customNames(list: HarnessList): string[] {
  return (list ?? []).filter((entry) => !isHarnessRuleSlug(entry));
}

/** Result of {@link addCustomName}. */
export type AddCustomResult =
  | { readonly ok: true; readonly list: string[] }
  | { readonly ok: false; readonly error: string };

/**
 * Adds a custom name as typed (trimmed). A name that *is* a known slug selects that harness instead,
 * since it would match it anyway.
 */
export function addCustomName(list: HarnessList, raw: string): AddCustomResult {
  const name = raw.trim();
  const problem = harnessRuleEntryProblem(name);
  if (problem !== null)
    return { ok: false, error: `${problem[0]?.toUpperCase()}${problem.slice(1)}.` };
  const current = list ?? [];
  if (current.includes(name)) return { ok: false, error: `"${name}" is already in the list.` };
  if (current.length >= HARNESS_RULE_MAX_ENTRIES) {
    return { ok: false, error: `A rule names at most ${HARNESS_RULE_MAX_ENTRIES} harnesses.` };
  }
  return { ok: true, list: [...current, name] };
}

/** Replaces one entry (the lookalike fix), keeping the order and dropping a duplicate. */
export function replaceEntry(list: HarnessList, from: string, to: string): string[] {
  const out: string[] = [];
  for (const entry of list ?? []) {
    const next = entry === from ? to : entry;
    if (!out.includes(next)) out.push(next);
  }
  return out;
}

/** Display text of one entry: the label of a known slug, a custom name as written. */
export function entryLabel(entry: string): string {
  return isHarnessRuleSlug(entry) ? harnessLabel(entry) : entry;
}

/**
 * One-line summary for tables and headers, or `null` when there is no list (every harness):
 * `no harness`, `Claude Code, OpenCode`, `Claude Code, OpenCode +2`.
 */
export function harnessRuleSummary(list: readonly string[] | null | undefined): string | null {
  if (list === null || list === undefined) return null;
  if (list.length === 0) return 'no harness';
  const labels = list.map(entryLabel);
  return labels.length <= 2
    ? labels.join(', ')
    : `${labels.slice(0, 2).join(', ')} +${labels.length - 2}`;
}

/** A warning the field shows under the chips. */
export type HarnessWarning =
  | { readonly kind: 'empty' }
  | { readonly kind: 'lookalike'; readonly entry: string; readonly slug: KnownHarness }
  | { readonly kind: 'blocks-recent'; readonly sessions: number }
  | { readonly kind: 'shared-principal' };

/**
 * The field's warnings, each at most once (spec 04 §12.7): an empty list; custom names that fold to
 * a built-in harness; a list that refuses every session launched in the window; and a list used
 * while every recent session comes from one principal.
 */
export function harnessWarnings(
  list: HarnessList,
  seen: VaultHarnessesResponse | undefined,
): HarnessWarning[] {
  if (list === null) return [];
  const out: HarnessWarning[] = [];
  if (list.length === 0) out.push({ kind: 'empty' });
  for (const entry of customNames(list)) {
    const slug = harnessRuleLookalike(entry);
    if (slug !== null) out.push({ kind: 'lookalike', entry, slug });
  }
  const launched = (seen?.data ?? []).filter((row) => row.sessions > 0);
  const sessions = launched.reduce((n, row) => n + row.sessions, 0);
  if (
    list.length > 0 &&
    sessions > 0 &&
    !launched.some((row) =>
      isHarnessAllowed(list, { harness: row.harness, declared: row.declared }),
    )
  ) {
    out.push({ kind: 'blocks-recent', sessions });
  }
  if (sessions > 0 && seen !== undefined && seen.principals <= 1) {
    out.push({ kind: 'shared-principal' });
  }
  return out;
}

/** Declared names seen on this daemon that are not in the list and not a known slug: the "+ name" suggestions. */
export function seenSuggestions(
  list: HarnessList,
  seen: VaultHarnessesResponse | undefined,
): string[] {
  const out: string[] = [];
  for (const row of seen?.data ?? []) {
    const name = row.declared;
    if (name === null || isHarnessRuleSlug(name) || list?.includes(name) === true) continue;
    if (harnessRuleEntryProblem(name) !== null || out.includes(name)) continue;
    out.push(name);
  }
  return out.slice(0, 8);
}

/** Known slugs seen recently (for the chips' "seen" dot). */
export function seenSlugs(seen: VaultHarnessesResponse | undefined): Set<string> {
  return new Set((seen?.data ?? []).map((row) => row.harness));
}

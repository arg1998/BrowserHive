/** @module cli/commands/sitepacks-classes — classifications and strategies in the `sitepacks` output (spec 13 §9.4, §9.7, §11.5): the dashboard's words for each class with the internal term, the per-class counts of a diff, and a pack's strategies with each parameter's value in force, default and bounds from `GET /site-packs/strategies` */
import {
  type SitePackClassification,
  type SitePackDiffResponse,
  SiteStrategiesResponse,
  type SiteStrategyParam,
} from '@browserhive/contracts/http';
import type { SitePackV1 } from '@browserhive/contracts/site-packs';
import type { CommandContext } from '../deps.ts';
import type { RemoteTarget } from '../invocation.ts';
import { sitePackCall } from './sitepacks-common.ts';

/** The dashboard's words for a classification (spec 13 §11.4 vocabulary). */
export const CLASS_WORDS: Readonly<Record<SitePackClassification, string>> = {
  loosening: 'relaxes rules',
  restrictive: 'can stop the site',
  tightening: 'tightens rules',
  neutral: 'no rule change',
  new_pack: 'new pack',
  local_override: 'local override',
  revoked: 'revoked: the earlier version waits for you',
  unclassified: 'not classified',
};

/** "relaxes rules (loosening)": the words, then the term the docs and `--json` use. */
export function classText(classification: SitePackClassification): string {
  const words = CLASS_WORDS[classification];
  return words.startsWith(classification.replace('_', ' '))
    ? words
    : `${words} (${classification})`;
}

/** A classification coloured by what it asks of the operator. */
export function styledClass(context: CommandContext, cls: SitePackClassification): string {
  const { style } = context.out;
  const text = classText(cls);
  if (cls === 'loosening' || cls === 'revoked') return style.red(text);
  if (cls === 'restrictive') return style.yellow(text);
  if (cls === 'tightening') return style.green(text);
  return style.dim(text);
}

/** "2 loosening, 1 tightening": the fields of a diff per class, strongest first. */
export function classCounts(diff: SitePackDiffResponse): string {
  const order = ['loosening', 'restrictive', 'tightening', 'neutral'] as const;
  return order
    .map((cls) => [cls, diff.changes.filter((c) => c.class === cls).length] as const)
    .filter(([, n]) => n > 0)
    .map(([cls, n]) => `${n} ${cls}`)
    .join(', ');
}

/**
 * `GET /site-packs/strategies`; `null` when it fails (the strategies then print without their
 * titles and defaults).
 */
export async function fetchStrategies(
  context: CommandContext,
  remote: RemoteTarget,
): Promise<SiteStrategiesResponse | null> {
  const result = await sitePackCall(context, remote, 'GET', '/site-packs/strategies');
  if (!result.ok) return null;
  const parsed = SiteStrategiesResponse.safeParse(result.json);
  return parsed.success ? parsed.data : null;
}

type Raw = number | boolean | string | undefined;

function valueText(value: Raw | null): string {
  if (value === undefined || value === null) return '—';
  return typeof value === 'boolean' ? (value ? 'on' : 'off') : String(value);
}

/**
 * One parameter: "min_ms 800 (default 600, 0–10000)", clamped values marked; `lower` is the value
 * in force of the parameter `min_from` names ("max_ms … min_ms–20000", review #84 L3).
 */
function paramText(param: SiteStrategyParam, raw: Raw, lower?: number): string {
  const bounds =
    param.min !== null && param.max !== null
      ? `, ${param.min_from ?? param.min}–${param.max}`
      : param.values !== null
        ? `, ${param.values.join('|')}`
        : '';
  const fallback =
    param.default !== null
      ? valueText(param.default)
      : `${param.default_from ?? '—'}${param.fallback === null ? '' : ` else ${param.fallback}`}`;
  if (raw === undefined) return `${param.name} default (${fallback}${bounds})`;
  if (typeof raw === 'number' && param.min !== null && param.max !== null) {
    const kept = Math.min(param.max, Math.max(param.min, lower ?? param.min, raw));
    if (kept !== raw) return `${param.name} ${kept}, asked ${raw} (default ${fallback}${bounds})`;
  }
  return `${param.name} ${valueText(raw)} (default ${fallback}${bounds})`;
}

function refText(ref: SitePackDiffResponse['to']): string {
  return `${ref.version === null ? 'local file' : `v${ref.version}`} (${ref.source}, sha-256 ${ref.sha256.slice(0, 12)}…)`;
}

/** A JSON value on one line, at most 160 characters. */
function jsonText(value: unknown): string {
  if (value === undefined) return '(absent)';
  const text = JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

/**
 * Prints a classified field-level diff (spec 13 §9.7): the two versions, the candidate's
 * classification, new domains, one line per changed field with its class, then the counts.
 */
export function printDiff(
  context: CommandContext,
  packId: string,
  diff: SitePackDiffResponse,
): void {
  const { out } = context;
  const from = diff.from === null ? 'nothing approved' : refText(diff.from);
  out.line(`${out.style.bold(packId)}: ${from} → ${refText(diff.to)}`);
  out.line(`Classification: ${styledClass(context, diff.classification)}`);
  if (diff.new_domains.length > 0) {
    out.status(
      'warn',
      `adds domain(s) ${diff.new_domains.join(', ')}`,
      "the pack's rules would apply there too",
    );
  }
  if (diff.changes.length === 0) {
    out.line('No field changes.');
    return;
  }
  for (const change of diff.changes) {
    const tag = change.class === null ? '' : ` [${styledClass(context, change.class)}]`;
    out.line(`  ${change.path}${tag}`);
    out.line(`    ${out.style.red(`- ${jsonText(change.from)}`)}`);
    out.line(`    ${out.style.green(`+ ${jsonText(change.to)}`)}`);
  }
  const counts = classCounts(diff);
  out.line(`${diff.changes.length} field(s) changed${counts === '' ? '' : `: ${counts}`}.`);
}

/** A numeric parameter's value in force: the pack's, clamped to its bounds, else its default. */
function inForce(
  params: readonly SiteStrategyParam[],
  values: Readonly<Record<string, Raw>>,
  name: string,
): number | undefined {
  const param = params.find((p) => p.name === name);
  if (param === undefined) return undefined;
  const raw = values[name];
  if (typeof raw !== 'number') return typeof param.default === 'number' ? param.default : undefined;
  return Math.min(param.max ?? raw, Math.max(param.min ?? raw, raw));
}

/** Prints a pack's strategies, one block each: id and title, then its parameters. */
export function printStrategies(
  context: CommandContext,
  pack: SitePackV1,
  table: SiteStrategiesResponse | null,
): void {
  const { out } = context;
  if (pack.strategies.length === 0) return;
  out.line();
  out.line('Strategies:');
  for (const selected of pack.strategies) {
    const spec = table?.data.find((s) => s.id === selected.id);
    const title = spec === undefined ? '' : ` — ${spec.title} (${spec.kind})`;
    out.line(`  ${out.style.bold(selected.id)}${title}`);
    const params = spec?.params ?? [];
    for (const param of params) {
      const lower =
        param.min_from === null ? undefined : inForce(params, selected.params, param.min_from);
      out.line(`    ${paramText(param, selected.params[param.name], lower)}`);
    }
    for (const [name, value] of Object.entries(selected.params)) {
      if (!params.some((p) => p.name === name)) out.line(`    ${name} ${valueText(value)}`);
    }
    if (params.length === 0 && Object.keys(selected.params).length === 0) {
      out.line(`    ${out.style.dim('no parameters')}`);
    }
  }
}

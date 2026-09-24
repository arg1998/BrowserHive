/** @module contracts/harness — the agent-harness vocabulary (spec 02 §1.4, D-30): known slugs with display labels, the `clientInfo.name` and `User-Agent` alias tables, `normalizeHarness()`, the metric fold and the meta-bag caps. Self-reported observability only: nothing here is ever used for a decision. */

/** Known harness slugs, in display order. `other` and `unknown` are real, countable values. */
export const HARNESS_SLUGS = [
  'claude-code',
  'claude-desktop',
  'codex',
  'cursor',
  'cursor-cli',
  'opencode',
  'gemini-cli',
  'vscode',
  'copilot-cli',
  'cline',
  'roo-code',
  'kilo-code',
  'windsurf',
  'continue',
  'zed',
  'goose',
  'lm-studio',
  'jetbrains',
  'junie',
  'n8n',
  'raycast',
  'crush',
  'other',
  'unknown',
] as const;
/** A known harness slug. On the wire `harness` is any string; this is the display/ordering hint. */
export type KnownHarness = (typeof HARNESS_SLUGS)[number];

/** Nothing identified the client. */
export const UNKNOWN_HARNESS = 'unknown';
/** The metric bucket for every slug outside {@link HARNESS_SLUGS}. */
export const OTHER_HARNESS = 'other';

/** Display label per known slug. */
export const HARNESS_LABELS: Readonly<Record<KnownHarness, string>> = {
  'claude-code': 'Claude Code',
  'claude-desktop': 'Claude Desktop',
  codex: 'Codex',
  cursor: 'Cursor',
  'cursor-cli': 'Cursor CLI',
  opencode: 'OpenCode',
  'gemini-cli': 'Gemini CLI',
  vscode: 'VS Code',
  'copilot-cli': 'GitHub Copilot CLI',
  cline: 'Cline',
  'roo-code': 'Roo Code',
  'kilo-code': 'Kilo Code',
  windsurf: 'Windsurf',
  continue: 'Continue',
  zed: 'Zed',
  goose: 'Goose',
  'lm-studio': 'LM Studio',
  jetbrains: 'JetBrains',
  junie: 'Junie',
  n8n: 'n8n',
  raycast: 'Raycast',
  crush: 'Crush',
  other: 'Other',
  unknown: 'Unknown',
};

/**
 * How a harness was recognised, highest precedence first (spec 02 §1.4). The vocabulary is open:
 * `token` is reserved for a verified credential binding.
 */
export const HARNESS_SOURCES = [
  'env',
  'header',
  'injected_env',
  'url',
  'meta',
  'client_info',
  'user_agent',
  'none',
] as const;
/** How a harness was recognised. */
export type HarnessSource = (typeof HARNESS_SOURCES)[number];

/** Where a declared model or workspace came from. */
export const DECLARED_SOURCES = ['header', 'env', 'meta'] as const;
/** Where a declared model or workspace came from. */
export type DeclaredSource = (typeof DECLARED_SOURCES)[number];

/** Operator-facing phrase for each source (dashboard detail, docs). Unknown sources read as themselves. */
export const HARNESS_SOURCE_LABELS: Readonly<Record<HarnessSource, string>> = {
  env: 'declared in BROWSERHIVE_HARNESS',
  header: 'declared by header',
  injected_env: 'set by the harness in the environment',
  url: 'declared in the URL',
  meta: 'declared in _meta',
  client_info: 'from clientInfo',
  user_agent: 'from the User-Agent',
  none: 'not identified',
};

/** Largest sanitised slug. */
export const HARNESS_SLUG_MAX = 32;

/** `clientInfo.name` values SDKs send when the author set none: they identify nothing. */
export const GENERIC_CLIENT_NAMES: readonly string[] = [
  'mcp',
  'mcp-client',
  'example-client',
  'test-client',
  'client',
];

/**
 * `clientInfo.name` → slug, matched lower-cased and trimmed. Sources are cited in
 * `docs/guide/mcp-clients.md` (how each harness is recognised).
 */
export const CLIENT_NAME_ALIASES: Readonly<Record<string, KnownHarness>> = {
  'claude-code': 'claude-code',
  'claude-ai': 'claude-desktop',
  'codex-mcp-client': 'codex',
  'cursor-vscode': 'cursor',
  'cursor-agent': 'cursor-cli',
  opencode: 'opencode',
  'gemini-cli-mcp-client': 'gemini-cli',
  'visual studio code': 'vscode',
  'visual studio code - insiders': 'vscode',
  'code - oss': 'vscode',
  'github-copilot-developer': 'copilot-cli',
  cline: 'cline',
  'roo-code': 'roo-code',
  'roo code': 'roo-code',
  'kilo-code': 'kilo-code',
  'kilo code': 'kilo-code',
  windsurf: 'windsurf',
  'continue-client': 'continue',
  'continue-cli-client': 'continue',
  zed: 'zed',
  'lm studio': 'lm-studio',
  lmstudio: 'lm-studio',
  junie: 'junie',
  'com.raycast.macos': 'raycast',
  crush: 'crush',
};

/** `clientInfo.name` prefixes (names that carry a variant or a build after a fixed stem). */
const CLIENT_NAME_PREFIXES: readonly (readonly [string, KnownHarness])[] = [
  ['goose', 'goose'],
  ['@n8n/', 'n8n'],
  ['jetbrains-', 'jetbrains'],
];

/** `User-Agent` patterns that name a harness; any other User-Agent is no signal. */
export const USER_AGENT_PATTERNS: readonly (readonly [RegExp, KnownHarness])[] = [
  [/^codex-mcp-client\//i, 'codex'],
  [/^claude-code\//i, 'claude-code'],
  [/^Cursor\/\d/, 'cursor'],
  [/\bClaude\/\d[^ ]*.*\bElectron\//, 'claude-desktop'],
];

/** Environment variables a harness sets for the stdio servers it spawns (spec 02 §1.4). */
export const INJECTED_ENV_HARNESSES: readonly (readonly [string, KnownHarness])[] = [
  ['CLAUDECODE', 'claude-code'],
  ['GEMINI_CLI', 'gemini-cli'],
];

const KNOWN = new Set<string>(HARNESS_SLUGS);

/** Whether `slug` is in the known table. */
export function isKnownHarness(slug: string): slug is KnownHarness {
  return KNOWN.has(slug);
}

function compact(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Declared spellings, compared without case or punctuation (`Claude Code`, `claude_code`). */
const DECLARED_ALIASES: ReadonlyMap<string, KnownHarness> = (() => {
  const map = new Map<string, KnownHarness>();
  for (const [name, slug] of Object.entries(CLIENT_NAME_ALIASES)) map.set(compact(name), slug);
  for (const slug of HARNESS_SLUGS) {
    map.set(compact(slug), slug);
    map.set(compact(HARNESS_LABELS[slug]), slug);
  }
  map.set('gemini', 'gemini-cli');
  return map;
})();

/**
 * Lower-case, runs of anything but `[a-z0-9]` become `-`, trimmed of `-`, at most
 * {@link HARNESS_SLUG_MAX} characters.
 *
 * @returns The slug, or `null` when nothing is left.
 */
export function sanitizeHarnessSlug(value: string): string | null {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, HARNESS_SLUG_MAX)
    .replace(/-+$/g, '');
  return slug === '' ? null : slug;
}

/**
 * Normalises a *declared* harness (header, env, `?harness=`, `_meta`): a known slug, label or alias
 * in any case or punctuation maps to its slug; anything else is kept as a sanitised slug.
 * Idempotent on slugs.
 *
 * @returns The slug, or `null` for a blank value.
 */
export function normalizeHarness(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const lower = trimmed.toLowerCase();
  if (KNOWN.has(lower)) return lower;
  const known = DECLARED_ALIASES.get(compact(trimmed));
  if (known !== undefined) return known;
  return sanitizeHarnessSlug(trimmed);
}

/**
 * The harness a `clientInfo.name` identifies: an alias-table match, `unknown` for generic SDK
 * defaults, else the sanitised name.
 *
 * @returns The slug (`unknown` when the name identifies nothing).
 */
export function harnessFromClientName(name: string | null | undefined): string {
  const lower = (name ?? '').trim().toLowerCase();
  if (lower === '' || GENERIC_CLIENT_NAMES.includes(lower)) return UNKNOWN_HARNESS;
  const direct = CLIENT_NAME_ALIASES[lower];
  if (direct !== undefined) return direct;
  if (KNOWN.has(lower)) return lower;
  for (const [prefix, slug] of CLIENT_NAME_PREFIXES) {
    if (lower.startsWith(prefix)) return slug;
  }
  return sanitizeHarnessSlug(lower) ?? UNKNOWN_HARNESS;
}

/**
 * The harness a `User-Agent` identifies, or `null` (most User-Agents are a platform default and
 * say nothing about the harness).
 *
 * @returns The slug or `null`.
 */
export function harnessFromUserAgent(userAgent: string | null | undefined): KnownHarness | null {
  if (userAgent === null || userAgent === undefined) return null;
  for (const [pattern, slug] of USER_AGENT_PATTERNS) {
    if (pattern.test(userAgent)) return slug;
  }
  return null;
}

/**
 * Display label: the known label, else the slug itself.
 *
 * @returns The label.
 */
export function harnessLabel(slug: string | null | undefined): string {
  if (slug === null || slug === undefined || slug === '') return HARNESS_LABELS.unknown;
  return isKnownHarness(slug) ? HARNESS_LABELS[slug] : slug;
}

/**
 * The value a metric attribute may carry: a known slug, everything else folded into `other`
 * (spec 10 §7 cardinality rule).
 *
 * @returns A member of {@link HARNESS_SLUGS}.
 */
export function metricHarness(slug: string | null | undefined): KnownHarness {
  if (slug === null || slug === undefined || slug === '') return 'unknown';
  return isKnownHarness(slug) ? slug : 'other';
}

/** Operator-facing phrase for a harness source. */
export function harnessSourceLabel(source: string | null | undefined): string {
  if (source === null || source === undefined) return HARNESS_SOURCE_LABELS.none;
  return (HARNESS_SOURCE_LABELS as Readonly<Record<string, string>>)[source] ?? source;
}

// --- meta bag -----------------------------------------------------------------------------------

/** Most keys in a meta bag. */
export const META_MAX_KEYS = 16;
/** Longest meta key (characters). */
export const META_MAX_KEY_LENGTH = 64;
/** Largest meta value (UTF-8 bytes). */
export const META_MAX_VALUE_BYTES = 256;
/** Largest meta bag, keys plus values (UTF-8 bytes). */
export const META_MAX_TOTAL_BYTES = 4096;

/** A capped meta bag and how many entries did not fit. */
export interface CappedMeta {
  readonly meta: Readonly<Record<string, string>>;
  readonly dropped: number;
}

const encoder = new TextEncoder();

function metaValue(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return null;
}

/**
 * Applies the meta-bag caps in insertion order (first come, first kept): 16 keys, key ≤ 64 chars,
 * value ≤ 256 bytes, 4 KiB total. Values must be strings, finite numbers or booleans; anything
 * else, an empty key and every entry past a cap count as dropped.
 *
 * @returns The kept entries and the dropped count.
 */
export function capMetaBag(entries: Iterable<readonly [string, unknown]>): CappedMeta {
  const meta: Record<string, string> = {};
  let keys = 0;
  let total = 0;
  let dropped = 0;
  for (const [key, raw] of entries) {
    if (Object.hasOwn(meta, key)) continue;
    const value = metaValue(raw);
    if (key === '' || key.length > META_MAX_KEY_LENGTH || value === null) {
      dropped += 1;
      continue;
    }
    const bytes = encoder.encode(key).length + encoder.encode(value).length;
    if (
      keys >= META_MAX_KEYS ||
      encoder.encode(value).length > META_MAX_VALUE_BYTES ||
      total + bytes > META_MAX_TOTAL_BYTES
    ) {
      dropped += 1;
      continue;
    }
    meta[key] = value;
    keys += 1;
    total += bytes;
  }
  return { meta, dropped };
}

// --- request vocabulary ---------------------------------------------------------------------------

/** Header names (lower-case, as HTTP delivers them). The first of each pair is the documented one. */
export const IDENTITY_HEADERS = {
  harness: ['x-bh-agent-harness', 'x-bh-harness'],
  model: ['x-bh-agent-model', 'x-bh-model'],
  workspace: ['x-bh-workspace'],
} as const;
/** Prefix of meta-bag headers (`X-BH-Meta-<Name>`). */
export const META_HEADER_PREFIX = 'x-bh-meta-';
/** `_meta` key prefixes read for identity; the first is the documented, reverse-DNS one. */
export const IDENTITY_META_PREFIXES = ['ai.browserhive/', 'browserhive.ai/'] as const;
/** `_meta` names under the prefixes that are never part of the meta bag (tracing, errors). */
export const RESERVED_META_NAMES: readonly string[] = [
  'harness',
  'model',
  'workspace',
  'traceId',
  'error',
];
/** URL query parameter on `/mcp`. */
export const HARNESS_QUERY_PARAM = 'harness';

/** @module features/notifications/channels/model — pure channel logic for the dashboard: categories, presets, TTL choices (Telegram capped at 47 h), rule summaries, launch-method snippets for environment variables, the wizard draft (localStorage, survives a restart) and its conversion to the API body (spec 04 §12.11.1, D-33, D-35, D-36) */
import type { NotificationCategory } from '@browserhive/contracts/enums';
import type { ChannelInput, ChannelPatch, ChannelView } from '@browserhive/contracts/http';
import {
  type AvailableChannelKind,
  CHANNEL_KIND_SPECS,
  CHANNEL_PRESETS,
  type ChannelConfigProblem,
  checkChannelConfig,
  type NotificationChannelRules,
  NTFY_DEFAULT_SERVER,
  TELEGRAM_TTL_MAX_MS,
} from '@browserhive/contracts/notifications';
import { readStorage, removeStorage, writeStorage } from '@/lib/storage.ts';

/** Every category, in the order the setup lists them. */
export const CATEGORIES: readonly {
  readonly id: NotificationCategory;
  readonly label: string;
  readonly describe: string;
  /** Screenshots can be attached to this category (attention, vault confirm, crash; D-36). */
  readonly images: boolean;
}[] = [
  {
    id: 'needs-you',
    label: 'Needs you',
    describe: 'Attention requests and vault fills waiting for approval.',
    images: true,
  },
  {
    id: 'problems',
    label: 'Problems',
    describe: 'Crashed or reaped sessions and failing tool calls.',
    images: true,
  },
  {
    id: 'wrap-ups',
    label: 'Wrap-ups',
    describe: 'Finished sessions and completed fills.',
    images: false,
  },
  {
    id: 'reports',
    label: 'Reports',
    describe: 'Daily digests and anomaly reports.',
    images: false,
  },
  {
    id: 'system',
    label: 'System',
    describe: 'BrowserHive itself degraded or recovered.',
    images: false,
  },
];

/** Label of a category. */
export function categoryLabel(id: string): string {
  return CATEGORIES.find((c) => c.id === id)?.label ?? id;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** TTL choices (`null` = never, the default, D-35). */
export function ttlChoices(
  kind: string | null,
): readonly { readonly value: number | null; readonly label: string }[] {
  const base: { value: number | null; label: string }[] = [
    { value: null, label: 'Never' },
    { value: 15 * MINUTE, label: '15 minutes' },
    { value: HOUR, label: '1 hour' },
    { value: 2 * HOUR, label: '2 hours' },
    { value: 6 * HOUR, label: '6 hours' },
    { value: 12 * HOUR, label: '12 hours' },
    { value: DAY, label: '1 day' },
  ];
  if (kind === 'telegram')
    return [...base, { value: TELEGRAM_TTL_MAX_MS, label: "47 hours (Telegram's limit)" }];
  return [...base, { value: 2 * DAY, label: '2 days' }, { value: 7 * DAY, label: '7 days' }];
}

/** Short human TTL ("2 h", "15 min", "7 d"). */
export function formatTtl(ms: number): string {
  if (ms % DAY === 0) return `${ms / DAY} d`;
  if (ms % HOUR === 0) return `${ms / HOUR} h`;
  return `${Math.round(ms / MINUTE)} min`;
}

/** The preset whose categories equal the rule's categories, or `null` (custom). */
export function presetOf(rules: NotificationChannelRules): string | null {
  const current = rules.categories === undefined ? null : [...rules.categories].sort().join(',');
  for (const preset of CHANNEL_PRESETS) {
    const want = preset.categories === null ? null : [...preset.categories].sort().join(',');
    if (want === current) return preset.id;
  }
  return null;
}

/** Rules with the preset's categories (other settings kept). */
export function applyPreset(
  rules: NotificationChannelRules,
  presetId: string,
): NotificationChannelRules {
  const preset = CHANNEL_PRESETS.find((p) => p.id === presetId);
  if (preset === undefined) return rules;
  const { categories: _categories, ...rest } = rules;
  return preset.categories === null ? rest : { ...rest, categories: [...preset.categories] };
}

/** One-line summary of what a channel sends ("Needs you, Problems · warn and up · quiet 22:00–07:00"). */
export function rulesSummary(rules: NotificationChannelRules): string {
  const parts: string[] = [];
  const preset = presetOf(rules);
  const presetLabel = CHANNEL_PRESETS.find((p) => p.id === preset)?.label;
  if (presetLabel !== undefined) parts.push(presetLabel);
  else if (rules.categories !== undefined)
    parts.push(rules.categories.map(categoryLabel).join(', '));
  if (rules.min_severity !== undefined && rules.min_severity !== 'info') {
    parts.push(`${rules.min_severity} and up`);
  }
  if (rules.sessions !== undefined && rules.sessions.length > 0)
    parts.push(rules.sessions.join(' '));
  if (rules.quiet_hours !== undefined) {
    parts.push(`quiet ${rules.quiet_hours.start}–${rules.quiet_hours.end}`);
  }
  const images = Object.entries(rules.images ?? {}).filter(([, on]) => on === true);
  if (images.length > 0)
    parts.push(rules.mask_images === true ? 'masked screenshots' : 'screenshots');
  const ttls = Object.values(rules.ttl_ms ?? {}).filter((v): v is number => typeof v === 'number');
  if (ttls.length > 0) parts.push(`self-destruct ${formatTtl(Math.min(...ttls))}`);
  return parts.join(' · ');
}

/** How BrowserHive is started, for the environment variable instructions. */
export type LaunchMethod = 'shell' | 'systemd' | 'docker' | 'config';

/** Labels of the launch methods. */
export const LAUNCH_METHODS: readonly { readonly id: LaunchMethod; readonly label: string }[] = [
  { id: 'shell', label: 'Shell' },
  { id: 'systemd', label: 'systemd' },
  { id: 'docker', label: 'Docker' },
  { id: 'config', label: 'Config file' },
];

/** The lines that put `name` in BrowserHive's environment, for one launch method. */
export function envSnippet(method: LaunchMethod, names: readonly string[]): string {
  const vars = names.length > 0 ? names : ['BH_SECRET'];
  switch (method) {
    case 'shell':
      return [
        ...vars.map((n) => `export ${n}='<paste the value here>'`),
        'browserhive --admin',
      ].join('\n');
    case 'systemd':
      return [
        '# sudo systemctl edit browserhive',
        '[Service]',
        ...vars.map((n) => `Environment="${n}=<paste the value here>"`),
        '# then: sudo systemctl restart browserhive',
      ].join('\n');
    case 'docker':
      return [
        'docker run \\',
        ...vars.map((n) => `  -e ${n}='<paste the value here>' \\`),
        '  … browserhive',
        '',
        '# docker compose: under the service',
        'environment:',
        ...vars.map((n) => `  ${n}: \${${n}}`),
      ].join('\n');
    case 'config':
      return [
        '# Channels read these variables directly; the config file never holds them.',
        '# Export them where BrowserHive starts, e.g. in the shell or service manager:',
        ...vars.map((n) => `export ${n}='<paste the value here>'`),
      ].join('\n');
  }
}

/** Steps of the setup wizard. */
export const WIZARD_STEPS = ['platform', 'credentials', 'connect', 'rules', 'preview'] as const;
/** One wizard step. */
export type WizardStep = (typeof WIZARD_STEPS)[number];

/** Labels of the wizard steps. */
export const WIZARD_STEP_LABEL: { readonly [S in WizardStep]: string } = {
  platform: 'Platform',
  credentials: 'Credentials',
  connect: 'Connect',
  rules: 'What to send',
  preview: 'Preview and test',
};

/** The wizard's working copy of a channel (kept in `localStorage` while adding one). */
export interface ChannelDraft {
  readonly v: 1;
  readonly kind: AvailableChannelKind | null;
  readonly mode: string | null;
  readonly name: string;
  readonly target: Readonly<Record<string, string>>;
  readonly secretRefs: Readonly<Record<string, string>>;
  readonly rules: NotificationChannelRules;
}

/** A blank draft. */
export const EMPTY_DRAFT: ChannelDraft = {
  v: 1,
  kind: null,
  mode: null,
  name: '',
  target: {},
  secretRefs: {},
  rules: {},
};

/** `localStorage` key of the add-channel draft (spec 04 §12.11.1). */
export const DRAFT_KEY = 'bh.channelDraft';

/** Reads the stored draft; `null` when absent or unreadable. */
export function readDraft(): ChannelDraft | null {
  const raw = readStorage(DRAFT_KEY);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || (parsed as { v?: unknown }).v !== 1) {
      return null;
    }
    const d = parsed as Partial<ChannelDraft>;
    return {
      ...EMPTY_DRAFT,
      ...d,
      target: { ...(d.target ?? {}) },
      secretRefs: { ...(d.secretRefs ?? {}) },
      rules: { ...(d.rules ?? {}) },
    };
  } catch {
    return null;
  }
}

/** Stores the draft. */
export function writeDraft(draft: ChannelDraft): void {
  writeStorage(DRAFT_KEY, JSON.stringify(draft));
}

/** Forgets the draft (after a save, or "Start over"). */
export function clearDraft(): void {
  removeStorage(DRAFT_KEY);
}

const TOPIC_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

/** A hard-to-guess ntfy topic (`bh-` + 12 random characters): on a public server the topic is the password. */
export function randomTopic(random: () => number = Math.random): string {
  let out = 'bh-';
  for (let i = 0; i < 12; i++) out += TOPIC_ALPHABET[Math.floor(random() * TOPIC_ALPHABET.length)];
  return out;
}

/** First name suggestions per platform. */
const NAME_SUGGESTION: Readonly<Record<string, string>> = {
  telegram: 'phone',
  discord: 'team',
  ntfy: 'push',
  webhook: 'hook',
};

/** A name not used by `taken` (`telegram`, `telegram-2`, …). */
export function suggestName(kind: string, taken: readonly string[]): string {
  const base = NAME_SUGGESTION[kind] ?? kind;
  if (!taken.includes(base)) return base;
  for (let i = 2; i < 100; i++) if (!taken.includes(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${Date.now() % 1000}`;
}

/** The draft after choosing a platform: its required secrets named, defaults filled, a preset. */
export function draftForKind(
  draft: ChannelDraft,
  kind: AvailableChannelKind,
  taken: readonly string[],
): ChannelDraft {
  if (draft.kind === kind) return draft;
  const spec = CHANNEL_KIND_SPECS[kind];
  const secretRefs: Record<string, string> = {};
  for (const s of spec.secrets) if (s.required) secretRefs[s.param] = s.suggestedEnv;
  const target: Record<string, string> = {};
  if (kind === 'ntfy') {
    target['server'] = NTFY_DEFAULT_SERVER;
    target['topic'] = randomTopic();
  }
  return {
    ...draft,
    kind,
    mode: spec.defaultMode,
    name: draft.name === '' || taken.includes(draft.name) ? suggestName(kind, taken) : draft.name,
    target,
    secretRefs,
    rules: Object.keys(draft.rules).length > 0 ? draft.rules : applyPreset({}, 'needs-me'),
  };
}

/** The draft of an existing channel (editing). */
export function draftFromChannel(channel: ChannelView): ChannelDraft {
  return {
    v: 1,
    kind: channel.kind as AvailableChannelKind,
    mode: channel.mode,
    name: channel.name,
    target: { ...channel.target },
    secretRefs: { ...channel.secret_refs },
    rules: { ...channel.rules },
  };
}

/** A duplicate of a channel (a free name, same settings). */
export function duplicateDraft(channel: ChannelView, taken: readonly string[]): ChannelDraft {
  const base = draftFromChannel(channel);
  let name = `${channel.name}-copy`.slice(0, 32);
  for (let i = 2; taken.includes(name) && i < 100; i++) name = `${channel.name}-${i}`.slice(0, 32);
  return { ...base, name };
}

/** Rules without empty keys (an empty session list means "every session", the absent default). */
export function cleanRules(rules: NotificationChannelRules): NotificationChannelRules {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rules)) {
    if (value === undefined) continue;
    if (Array.isArray(value) && value.length === 0 && key !== 'categories') continue;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const entries = Object.entries(value).filter(([, v]) => v !== undefined && v !== false);
      if (key !== 'quiet_hours' && entries.length === 0) continue;
      out[key] = key === 'quiet_hours' ? value : Object.fromEntries(entries);
      continue;
    }
    out[key] = value;
  }
  return out as NotificationChannelRules;
}

/** `POST /channels` body of a complete draft. */
export function draftToInput(draft: ChannelDraft): ChannelInput {
  return {
    name: draft.name,
    kind: draft.kind ?? 'webhook',
    mode: draft.mode,
    target: { ...draft.target },
    secret_refs: { ...draft.secretRefs },
    rules: cleanRules(draft.rules),
  };
}

/** `PATCH /channels/{id}` body of an edited draft. */
export function draftToPatch(draft: ChannelDraft): ChannelPatch {
  const { kind: _kind, ...rest } = draftToInput(draft);
  return rest;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Problems of a draft (platform config via the shared contract check, plus the name). */
export function draftProblems(draft: ChannelDraft): ChannelConfigProblem[] {
  if (draft.kind === null) return [{ field: 'kind', message: 'Choose a platform.' }];
  const problems = checkChannelConfig({
    kind: draft.kind,
    mode: draft.mode,
    target: draft.target,
    secretRefs: draft.secretRefs,
  });
  if (!NAME_RE.test(draft.name)) {
    problems.push({
      field: 'name',
      message:
        'Use up to 32 lowercase letters, digits and dashes, starting with a letter or digit.',
    });
  }
  if (draft.kind === 'telegram') {
    for (const [category, ttl] of Object.entries(draft.rules.ttl_ms ?? {})) {
      if (typeof ttl === 'number' && ttl > TELEGRAM_TTL_MAX_MS) {
        problems.push({
          field: `rules.ttl_ms.${category}`,
          message: 'Telegram lets a bot delete its messages for 48 hours only: at most 47 h.',
        });
      }
    }
  }
  return problems;
}

/** Problems that block leaving `step`. */
export function stepProblems(draft: ChannelDraft, step: WizardStep): ChannelConfigProblem[] {
  const all = draftProblems(draft);
  switch (step) {
    case 'platform':
      return all.filter((p) => p.field === 'kind' || p.field === 'mode');
    case 'credentials':
      return all.filter((p) => p.field.startsWith('secret_refs'));
    case 'connect':
      return all.filter((p) => p.field.startsWith('target'));
    case 'rules':
      return all.filter((p) => p.field === 'name' || p.field.startsWith('rules'));
    case 'preview':
      return all;
  }
}

/** The variables a draft names, required ones first. */
export function draftEnvNames(draft: ChannelDraft): string[] {
  return Object.values(draft.secretRefs).filter((n) => n.trim() !== '');
}

/** Whether a URL points at a private or loopback address (the webhook SSRF note). */
export function isPrivateUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd')) return true;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (m === null) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

/** The subscribe links for an ntfy topic (the app's deep link and the web page). */
export function ntfyLinks(
  server: string,
  topic: string,
): { readonly web: string; readonly app: string } {
  const base = server.replace(/\/+$/, '');
  let host = base;
  try {
    const url = new URL(base);
    host = `${url.host}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {
    // keep the raw value
  }
  return { web: `${base}/${topic}`, app: `ntfy://${host}/${topic}` };
}

/** Whether the ntfy server is the public ntfy.sh (attachments held 3 h on a public server, D-36). */
export function isPublicNtfy(server: string | undefined): boolean {
  return (server ?? NTFY_DEFAULT_SERVER).replace(/\/+$/, '') === NTFY_DEFAULT_SERVER;
}

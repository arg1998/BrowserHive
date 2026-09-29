/** @module app/config/notification-channel-flag — the flag-only `--notificationChannel` grammar (spec 08 §5.7, D-33, D-39): `<kind>:<param>=<value>,…` → `StartupNotificationChannel`, with secrets only as environment variable names (an inline secret is a usage error that never echoes it). Pure. */

import { zDuration } from '@browserhive/contracts/config';
import {
  NotificationCategory,
  NotificationContentLevel,
  NotificationSeverity,
} from '@browserhive/contracts/enums';
import {
  type AnomalyRule,
  AVAILABLE_CHANNEL_KINDS,
  AvailableChannelKind,
  CHANNEL_KIND_SPECS,
  type ChannelKindSpec,
  checkChannelConfig,
  checkChannelRules,
  DEFAULT_DIGEST_DAY,
  defaultDigest,
  NotificationChannelName,
  type NotificationChannelRules,
  NTFY_DEFAULT_SERVER,
  RESERVED_ENV_PREFIX,
  StartupNotificationChannel,
  TELEGRAM_TTL_MAX_MS,
  WEEKDAYS,
} from '@browserhive/contracts/notifications';
import { withSuggestion } from './failure.ts';
import { suggest } from './suggest.ts';

/** The flag's name. */
export const NOTIFICATION_CHANNEL_FLAG = '--notificationChannel';

/** Result of parsing every `--notificationChannel` value. */
export interface NotificationChannelFlagResult {
  readonly channels: readonly StartupNotificationChannel[];
  /** Usage errors (exit 64), without the `browserhive: ` prefix. Never contain a secret. */
  readonly problems: readonly string[];
  /** Warnings (a literal ntfy topic on the public server). */
  readonly warnings: readonly string[];
}

const RULE_PARAMS = [
  'name',
  'categories',
  'min',
  'sessions',
  'harness',
  'content',
  'quiet',
  'tz',
  'deleteWhenResolved',
  'images',
  'maskImages',
  'actButtons',
  'allow',
  'digest',
  'anomaly',
  'anomaly.errorRate',
  'anomaly.minCalls',
  'anomaly.attention',
  'anomaly.blocked',
  'anomaly.blockedMin',
  'anomaly.capacity',
  'anomaly.degraded',
] as const;

/** Secret parameters that must be `env:NAME` (topics and url may also be literal). */
const ALWAYS_SECRET: ReadonlySet<string> = new Set([
  'token',
  'webhook',
  'secret',
  'password',
  'reply_token',
]);

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const QUIET_RE = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;

function decode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** The flag parameter of a secret (`reply` for `reply_topic`). */
function flagOf(secret: ChannelKindSpec['secrets'][number]): string {
  return secret.flag ?? secret.param;
}

function paramsOf(spec: ChannelKindSpec): readonly string[] {
  return [
    ...new Set([
      ...RULE_PARAMS,
      ...spec.target.map((t) => t.param),
      ...spec.secrets.map(flagOf),
      ...(spec.modes === null ? [] : ['mode']),
    ]),
  ];
}

function isCategory(value: string): value is NotificationCategory {
  return NotificationCategory.safeParse(value).success;
}

function validZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function parseBool(value: string): boolean | null {
  const v = value.toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  return null;
}

/**
 * Parses every `--notificationChannel` value (spec 08 §5.7). Every problem of every value is
 * reported; a problem never contains the text of a secret parameter.
 *
 * @param values The flag values, in order.
 * @param env Reads the server's environment (a referenced variable must be set and non-empty).
 * @returns The parsed channels, usage problems and warnings.
 */
export function parseNotificationChannelFlags(
  values: readonly string[],
  env: (name: string) => string | undefined,
): NotificationChannelFlagResult {
  const channels: StartupNotificationChannel[] = [];
  const problems: string[] = [];
  const warnings: string[] = [];
  const names = new Set<string>();
  values.forEach((raw, index) => {
    const parsed = parseOne(raw, index, env, warnings);
    if (parsed.problems.length > 0) {
      problems.push(...parsed.problems);
      return;
    }
    const channel = parsed.channel;
    if (channel === null) return;
    if (names.has(channel.name)) {
      problems.push(
        `${NOTIFICATION_CHANNEL_FLAG}: the name '${channel.name}' is used by two channels. Names must be unique.`,
      );
      return;
    }
    names.add(channel.name);
    channels.push(channel);
  });
  return { channels, problems, warnings };
}

function parseOne(
  raw: string,
  index: number,
  env: (name: string) => string | undefined,
  warnings: string[],
): { readonly channel: StartupNotificationChannel | null; readonly problems: string[] } {
  const problems: string[] = [];
  const colon = raw.indexOf(':');
  const kindText = colon < 0 ? raw.trim() : raw.slice(0, colon).trim();
  const kind = AvailableChannelKind.safeParse(kindText);
  const nth = `${NOTIFICATION_CHANNEL_FLAG} #${index + 1}`;
  if (!kind.success) {
    const hint = suggest(kindText, AVAILABLE_CHANNEL_KINDS);
    problems.push(
      withSuggestion(
        `${nth}: unknown platform '${kindText}'. Expected ${AVAILABLE_CHANNEL_KINDS.join(', ')} followed by ':' and parameters, like "telegram:name=phone,token=env:BH_TG_TOKEN,chat=123456".`,
        hint.map((h) => `${h}:`),
      ),
    );
    return { channel: null, problems };
  }
  const spec = CHANNEL_KIND_SPECS[kind.data];
  const params = new Map<string, string>();
  const body = colon < 0 ? '' : raw.slice(colon + 1);
  const allowed = paramsOf(spec);
  for (const part of body.split(',')) {
    if (part.trim() === '') continue;
    const eq = part.indexOf('=');
    const key = (eq < 0 ? part : part.slice(0, eq)).trim();
    const value = eq < 0 ? '' : part.slice(eq + 1).trim();
    const known = allowed.includes(key) || /^ttl\.[a-z-]+$/.test(key);
    if (!known) {
      // A pasted secret without its `name=` is a "key": never echo anything that is not name-like.
      const nameLike = /^[A-Za-z][A-Za-z.-]{0,31}$/.test(key);
      problems.push(
        nameLike
          ? withSuggestion(
              `${nth}: unknown parameter '${key}' for ${spec.label}.`,
              suggest(key, allowed),
            )
          : `${nth}: a parameter is not written as name=value (not shown: it may be a secret).`,
      );
      continue;
    }
    if (params.has(key)) {
      problems.push(`${nth}: parameter '${key}' is given twice.`);
      continue;
    }
    if (eq < 0 || value === '') {
      problems.push(`${nth}: parameter '${key}' has no value.`);
      continue;
    }
    const decoded = decode(value);
    if (decoded === null) {
      // Never echo: the value might be a secret.
      problems.push(`${nth}: parameter '${key}' has a malformed percent-encoding.`);
      continue;
    }
    params.set(key, decoded);
  }
  const name = params.get('name');
  const label = name === undefined ? nth : `${NOTIFICATION_CHANNEL_FLAG} '${name}'`;
  if (name === undefined) problems.push(`${nth}: name is required (name=phone).`);
  else if (!NotificationChannelName.safeParse(name).success) {
    problems.push(
      `${label}: name must be lowercase letters, digits and dashes (up to 32), like 'phone'.`,
    );
  }
  const target: Record<string, string> = {};
  const secretRefs: Record<string, string> = {};
  // Secrets and the literal-or-variable parameters (flag parameter → secret parameter).
  const secretByFlag = new Map(spec.secrets.map((s) => [flagOf(s), s.param]));
  const secretParams = new Set(secretByFlag.keys());
  for (const [flag, value] of params) {
    const key = secretByFlag.get(flag);
    if (key === undefined) continue;
    const fromEnv = value.startsWith('env:');
    if (!fromEnv) {
      if (ALWAYS_SECRET.has(key)) {
        problems.push(
          `${label}: ${flag} must name an environment variable (${flag}=env:NAME), never contain the secret: other users of this machine can read process arguments.`,
        );
        continue;
      }
      target[key] = value;
      if (kind.data === 'ntfy' && key === 'topic') {
        const server = params.get('server') ?? NTFY_DEFAULT_SERVER;
        if (/^https?:\/\/ntfy\.sh\/?$/i.test(server)) {
          warnings.push(
            `${label}: the topic is written in the flag; on ntfy.sh the topic acts as a password. Prefer topic=env:NAME.`,
          );
        }
      }
      continue;
    }
    const envName = value.slice('env:'.length);
    if (!ENV_NAME_RE.test(envName)) {
      problems.push(`${label}: ${flag}=env:NAME needs a variable name ([A-Za-z_][A-Za-z0-9_]*).`);
      continue;
    }
    if (envName.startsWith(RESERVED_ENV_PREFIX)) {
      problems.push(
        `${label}: ${flag}: variables starting with ${RESERVED_ENV_PREFIX} are reserved for configuration; use another name.`,
      );
      continue;
    }
    const current = env(envName);
    if (current === undefined || current === '') {
      problems.push(
        `${label}: ${envName} is not set (${flag}=env:${envName}). Set it in the environment that starts BrowserHive.`,
      );
      continue;
    }
    secretRefs[key] = envName;
  }
  for (const t of spec.target) {
    const value = params.get(t.param);
    if (value !== undefined && !secretParams.has(t.param)) target[t.key] = value;
  }
  let mode: string | null = spec.defaultMode;
  const modeParam = params.get('mode');
  if (modeParam !== undefined) mode = modeParam;
  const inMode = (owner: string | undefined) => owner === undefined || owner === mode;
  const rules = parseRules(params, label, kind.data, problems);
  for (const t of spec.target) {
    if (t.required && inMode(t.mode) && !params.has(t.param)) {
      problems.push(
        `${label}: ${t.param} is required${t.mode === undefined ? '' : ` in ${t.mode} mode`}.`,
      );
    }
  }
  for (const secret of spec.secrets) {
    const flag = flagOf(secret);
    if (secret.required && inMode(secret.mode) && !params.has(flag)) {
      problems.push(
        `${label}: ${flag} is required${secret.mode === undefined ? '' : ` in ${secret.mode} mode`} (${flag}=env:NAME).`,
      );
    }
  }
  for (const key of spec.eitherTargetOrSecret) {
    if (!params.has(key)) problems.push(`${label}: ${key} is required.`);
  }
  if (problems.length === 0) {
    for (const problem of [
      ...checkChannelConfig({ kind: kind.data, mode, target, secretRefs }),
      ...checkChannelRules({ kind: kind.data, mode, target, secretRefs, rules }),
    ]) {
      problems.push(`${label}: ${paramForField(spec, problem.field)}: ${problem.message}`);
    }
  }
  if (problems.length > 0 || name === undefined) return { channel: null, problems };
  const channel = StartupNotificationChannel.safeParse({
    name,
    kind: kind.data,
    mode,
    target,
    secret_refs: secretRefs,
    rules,
  });
  if (!channel.success) {
    return { channel: null, problems: [`${label}: the channel is not valid.`] };
  }
  return { channel: channel.data, problems };
}

function paramForField(spec: ChannelKindSpec, field: string): string {
  if (field === 'rules.act_buttons') return 'actButtons';
  if (field === 'rules.allow_list') return 'allow';
  const key = field.replace(/^(target|secret_refs)\./, '');
  const secret = spec.secrets.find((s) => s.param === key);
  if (field.startsWith('secret_refs.') && secret !== undefined) return flagOf(secret);
  return spec.target.find((t) => t.key === key)?.param ?? key;
}

function list(value: string): string[] {
  return value
    .split('+')
    .map((v) => v.trim())
    .filter((v) => v !== '');
}

function categoriesOf(
  value: string,
  label: string,
  param: string,
  problems: string[],
): NotificationCategory[] | null {
  const items = list(value);
  const bad = items.filter((c) => !isCategory(c));
  if (bad.length > 0 || items.length === 0) {
    problems.push(
      `${label}: ${param} must be a + list of ${NotificationCategory.options.join(', ')}.`,
    );
    return null;
  }
  return items.filter(isCategory);
}

const DIGEST_RE =
  /^(daily|weekly)(?::(mon|tue|wed|thu|fri|sat|sun|weekdays))?(?:@([01]\d|2[0-3]):([0-5]\d))?$/;

const ANOMALY_NUMBERS = [
  { param: 'anomaly.errorRate', key: 'error_rate', min: 1, max: 100, off: true, int: false },
  { param: 'anomaly.minCalls', key: 'min_calls', min: 1, max: 100_000, off: false, int: true },
  {
    param: 'anomaly.attention',
    key: 'attention_minutes',
    min: 1,
    max: 10_080,
    off: true,
    int: true,
  },
  { param: 'anomaly.blocked', key: 'blocked_spike', min: 1.5, max: 1000, off: true, int: false },
  {
    param: 'anomaly.blockedMin',
    key: 'blocked_min',
    min: 1,
    max: 1_000_000,
    off: false,
    int: true,
  },
] as const;

/** `digest`, `anomaly` and `anomaly.*` (spec 08 §5.7, D-43, D-44). */
function parseReports(
  params: ReadonlyMap<string, string>,
  label: string,
  rules: { -readonly [K in keyof NotificationChannelRules]: NotificationChannelRules[K] },
  problems: string[],
): void {
  const digest = params.get('digest');
  if (digest !== undefined) {
    const m = DIGEST_RE.exec(digest.toLowerCase());
    if (m === null) {
      problems.push(
        `${label}: digest must be daily@HH:MM, daily:weekdays@HH:MM or weekly:<mon…sun>@HH:MM, like daily@09:00 or weekly:fri@17:00.`,
      );
    } else if (m[1] === 'daily' && m[2] !== undefined && m[2] !== 'weekdays') {
      problems.push(`${label}: a weekday applies to a weekly digest only (weekly:${m[2]}@…).`);
    } else if (m[1] === 'weekly' && m[2] === 'weekdays') {
      problems.push(`${label}: weekdays applies to a daily digest only (daily:weekdays@…).`);
    } else {
      const every = m[1] === 'weekly' ? 'week' : 'day';
      const base = defaultDigest(every);
      const at = m[3] === undefined ? base.at : `${m[3]}:${m[4]}`;
      rules.digest =
        every === 'week'
          ? { every, at, day: WEEKDAYS.find((d) => d === m[2]) ?? DEFAULT_DIGEST_DAY }
          : { every, at, ...(m[2] === 'weekdays' && { weekdays_only: true }) };
    }
  }
  const anomaly = params.get('anomaly');
  const on = anomaly === undefined ? null : parseBool(anomaly);
  if (anomaly !== undefined && on === null) problems.push(`${label}: anomaly must be on or off.`);
  const tuned = [...params.keys()].filter((k) => k.startsWith('anomaly.'));
  if (tuned.length > 0 && on !== true) {
    problems.push(`${label}: ${tuned[0]} needs anomaly=on.`);
    return;
  }
  if (on !== true) return;
  const rule: { -readonly [K in keyof AnomalyRule]: AnomalyRule[K] } = {};
  for (const spec of ANOMALY_NUMBERS) {
    const value = params.get(spec.param);
    if (value === undefined) continue;
    if (spec.off && ['off', 'false', 'no'].includes(value.toLowerCase())) {
      Object.assign(rule, { [spec.key]: null });
      continue;
    }
    const n = Number(value);
    if (!Number.isFinite(n) || n < spec.min || n > spec.max || (spec.int && !Number.isInteger(n))) {
      problems.push(
        `${label}: ${spec.param} must be ${spec.int ? 'a whole number' : 'a number'} from ${spec.min} to ${spec.max}${spec.off ? ', or off' : ''}.`,
      );
      continue;
    }
    Object.assign(rule, { [spec.key]: n });
  }
  for (const [param, key] of [
    ['anomaly.capacity', 'capacity'],
    ['anomaly.degraded', 'degraded'],
  ] as const) {
    const value = params.get(param);
    if (value === undefined) continue;
    const flag = parseBool(value);
    if (flag === null) problems.push(`${label}: ${param} must be on or off.`);
    else rule[key] = flag;
  }
  rules.anomaly = rule;
}

function parseRules(
  params: ReadonlyMap<string, string>,
  label: string,
  kind: AvailableChannelKind,
  problems: string[],
): NotificationChannelRules {
  const rules: {
    -readonly [K in keyof NotificationChannelRules]: NotificationChannelRules[K];
  } = {};
  const categories = params.get('categories');
  if (categories !== undefined) {
    const parsed = categoriesOf(categories, label, 'categories', problems);
    if (parsed !== null) rules.categories = parsed;
  }
  const min = params.get('min');
  if (min !== undefined) {
    const parsed = NotificationSeverity.safeParse(min);
    if (parsed.success) rules.min_severity = parsed.data;
    else problems.push(`${label}: min must be one of ${NotificationSeverity.options.join(', ')}.`);
  }
  const sessions = params.get('sessions');
  if (sessions !== undefined) rules.sessions = list(sessions);
  const harness = params.get('harness');
  if (harness !== undefined) rules.harness = list(harness);
  const content = params.get('content');
  if (content !== undefined) {
    const parsed = NotificationContentLevel.safeParse(content);
    if (parsed.success) rules.content = parsed.data;
    else
      problems.push(
        `${label}: content must be one of ${NotificationContentLevel.options.join(', ')}.`,
      );
  }
  const quiet = params.get('quiet');
  const tz = params.get('tz');
  if (quiet !== undefined) {
    const m = QUIET_RE.exec(quiet);
    if (m === null) problems.push(`${label}: quiet must be HH:MM-HH:MM, like 22:00-07:30.`);
    else {
      rules.quiet_hours = { start: `${m[1]}:${m[2]}`, end: `${m[3]}:${m[4]}` };
    }
  }
  if (tz !== undefined) {
    // The channel's zone: its quiet hours and its reports (D-43).
    if (validZone(tz)) rules.time_zone = tz;
    else
      problems.push(
        `${label}: tz '${tz.slice(0, 64)}' is not an IANA time zone (like Europe/Berlin).`,
      );
  }
  parseReports(params, label, rules, problems);
  const ttl: Partial<Record<NotificationCategory, number>> = {};
  for (const [key, value] of params) {
    if (!key.startsWith('ttl.')) continue;
    const category = key.slice('ttl.'.length);
    if (!isCategory(category)) {
      problems.push(
        withSuggestion(
          `${label}: unknown category '${category}' in ${key}.`,
          suggest(category, NotificationCategory.options).map((c) => `ttl.${c}`),
        ),
      );
      continue;
    }
    const parsed = zDuration.safeParse(value);
    if (!parsed.success || parsed.data <= 0) {
      problems.push(`${label}: ${key} must be a duration like 2h, 30m or 1d.`);
      continue;
    }
    if (kind === 'telegram' && parsed.data > TELEGRAM_TTL_MAX_MS) {
      problems.push(
        `${label}: ${key} is longer than 47h; Telegram lets a bot delete its messages for 48 hours only.`,
      );
      continue;
    }
    ttl[category] = parsed.data;
  }
  if (Object.keys(ttl).length > 0) rules.ttl_ms = ttl;
  const dwr = params.get('deleteWhenResolved');
  if (dwr !== undefined) {
    const flag = parseBool(dwr);
    if (flag !== null) {
      if (flag) {
        rules.delete_when_resolved = Object.fromEntries(
          NotificationCategory.options.map((c) => [c, true]),
        );
      }
    } else {
      const parsed = categoriesOf(dwr, label, 'deleteWhenResolved', problems);
      if (parsed !== null)
        rules.delete_when_resolved = Object.fromEntries(parsed.map((c) => [c, true]));
    }
  }
  const images = params.get('images');
  if (images !== undefined) {
    const parsed = categoriesOf(images, label, 'images', problems);
    if (parsed !== null) {
      rules.images = Object.fromEntries(parsed.map((c) => [c, true]));
      if (rules.content !== 'full') {
        problems.push(`${label}: images needs content=full (screenshots are full content).`);
      }
    }
  }
  const mask = params.get('maskImages');
  if (mask !== undefined) {
    const flag = parseBool(mask);
    if (flag === null) problems.push(`${label}: maskImages must be true or false.`);
    else rules.mask_images = flag;
  }
  const act = params.get('actButtons');
  if (act !== undefined) {
    const flag = parseBool(act);
    if (flag === null) problems.push(`${label}: actButtons must be true or false.`);
    else rules.act_buttons = flag;
  }
  const allow = params.get('allow');
  if (allow !== undefined) rules.allow_list = list(allow);
  return rules;
}

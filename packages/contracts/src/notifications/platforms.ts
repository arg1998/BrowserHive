/** @module contracts/notifications/platforms — what each notification platform needs (target keys, secret parameters, modes), the shared config check used by the API, the startup flag parser and the dashboard, the preview samples and the delivery-log reason texts (spec 03 §9.5, spec 08 §5.7, D-33, D-38, D-39). Platform-neutral. */

import { z } from 'zod';
import type { NotificationCategory } from '../enums/notification-category.ts';
import { type NotificationChannelRules, RESERVED_ENV_PREFIX } from './channel.ts';

/** Platforms that have an adapter (N1). The other `NotificationChannelKind` members are reserved. */
export const AVAILABLE_CHANNEL_KINDS = ['telegram', 'discord', 'ntfy', 'webhook'] as const;
/** A platform with an adapter. */
export const AvailableChannelKind = z.enum(AVAILABLE_CHANNEL_KINDS);
/** A platform with an adapter. */
export type AvailableChannelKind = z.infer<typeof AvailableChannelKind>;

/** Discord channel modes (D-38): one per channel. */
export const DISCORD_MODES = ['webhook', 'bot'] as const;
/** Discord modes a channel may be saved with. */
export const AVAILABLE_DISCORD_MODES: readonly string[] = DISCORD_MODES;

/**
 * Permissions the Discord bot's invite link asks for (D-38): View Channel (1 << 10), Send Messages
 * (1 << 11), Embed Links (1 << 14) and Attach Files (1 << 15). Nothing else is needed: a bot edits
 * and deletes its own messages, and interactions need no permission.
 */
export const DISCORD_BOT_PERMISSIONS = 52_224;

/**
 * The invite link that adds a bot to a server with {@link DISCORD_BOT_PERMISSIONS}.
 *
 * @returns `https://discord.com/oauth2/authorize?…`.
 */
export function discordInviteUrl(applicationId: string): string {
  return `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(applicationId)}&scope=bot&permissions=${DISCORD_BOT_PERMISSIONS}`;
}

/** Prefix of the payload an act button carries (`bh1:<token>`, D-41). */
export const ACTION_TOKEN_PREFIX = 'bh1:';
/** Characters of a command token (URL-safe, 6 bits each: 66 random bits). */
export const ACTION_TOKEN_LENGTH = 11;
/** A command token expires this long after it was minted (Telegram keeps presses 24 h). */
export const ACTION_TOKEN_TTL_MS = 24 * 60 * 60_000;
/** A button payload: `bh1:` and the token. */
export const ACTION_PAYLOAD_RE = /^bh1:([A-Za-z0-9_-]{11})$/;

/** Telegram lets a bot delete its own messages for 48 hours; setups cap TTLs one hour below (D-35). */
export const TELEGRAM_TTL_MAX_MS = 47 * 60 * 60_000;
/** Telegram's own delete window (the adapter's `deleteWindowMs`). */
export const TELEGRAM_DELETE_WINDOW_MS = 48 * 60 * 60_000;

/** Default ntfy server. */
export const NTFY_DEFAULT_SERVER = 'https://ntfy.sh';

/** One non-secret target key of a platform (`target_json`). */
export interface TargetKeySpec {
  readonly key: string;
  /** Startup flag parameter that fills it (`chat` → `chat_id`). */
  readonly param: string;
  readonly required: boolean;
  readonly describe: string;
  /** The key belongs to this mode only (Discord); `required` applies in that mode. */
  readonly mode?: string;
}

/** One secret parameter of a platform: stored as an environment variable name (D-33). */
export interface SecretParamSpec {
  readonly param: string;
  /** Startup flag parameter when it differs from `param` (`reply` for `reply_topic`). */
  readonly flag?: string;
  /** The parameter belongs to this mode only (Discord); `required` applies in that mode. */
  readonly mode?: string;
  readonly required: boolean;
  /** Variable name the setup suggests (never `BROWSERHIVE_*`). */
  readonly suggestedEnv: string;
  readonly describe: string;
}

/** What a platform needs. */
export interface ChannelKindSpec {
  readonly kind: AvailableChannelKind;
  readonly label: string;
  /** Modes (Discord only). */
  readonly modes: readonly string[] | null;
  readonly defaultMode: string | null;
  readonly target: readonly TargetKeySpec[];
  readonly secrets: readonly SecretParamSpec[];
  /**
   * Keys where exactly one of the target key or the secret parameter of the same name must be
   * set (an ntfy topic, a webhook URL: literal, or from a variable).
   */
  readonly eitherTargetOrSecret: readonly string[];
}

/** Every available platform. */
export const CHANNEL_KIND_SPECS: { readonly [K in AvailableChannelKind]: ChannelKindSpec } = {
  telegram: {
    kind: 'telegram',
    label: 'Telegram',
    modes: null,
    defaultMode: null,
    target: [
      {
        key: 'chat_id',
        param: 'chat',
        required: true,
        describe: 'Chat id (a person, a group, or a channel; groups start with -100).',
      },
      {
        key: 'thread_id',
        param: 'thread',
        required: false,
        describe: 'Forum topic id inside a group.',
      },
      { key: 'chat_title', param: 'title', required: false, describe: 'Name of the chat.' },
      { key: 'bot_username', param: 'bot', required: false, describe: "The bot's username." },
    ],
    secrets: [
      {
        param: 'token',
        required: true,
        suggestedEnv: 'BH_TELEGRAM_TOKEN',
        describe: 'The bot token from @BotFather.',
      },
    ],
    eitherTargetOrSecret: [],
  },
  discord: {
    kind: 'discord',
    label: 'Discord',
    modes: DISCORD_MODES,
    defaultMode: 'webhook',
    target: [
      {
        key: 'channel_id',
        param: 'channel',
        required: true,
        mode: 'bot',
        describe: 'Channel id the bot posts in.',
      },
      { key: 'guild_id', param: 'guild', required: false, mode: 'bot', describe: 'Server id.' },
      {
        key: 'guild_name',
        param: 'guildName',
        required: false,
        mode: 'bot',
        describe: 'Name of the server.',
      },
      {
        key: 'channel_name',
        param: 'channelName',
        required: false,
        mode: 'bot',
        describe: 'Name of the channel.',
      },
    ],
    secrets: [
      {
        param: 'webhook',
        mode: 'webhook',
        required: true,
        suggestedEnv: 'BH_DISCORD_WEBHOOK',
        describe: 'The webhook URL (Channel settings → Integrations → Webhooks).',
      },
      {
        param: 'token',
        mode: 'bot',
        required: true,
        suggestedEnv: 'BH_DISCORD_BOT_TOKEN',
        describe: 'The bot token (Developer Portal → your application → Bot → Reset Token).',
      },
    ],
    eitherTargetOrSecret: [],
  },
  ntfy: {
    kind: 'ntfy',
    label: 'ntfy',
    modes: null,
    defaultMode: null,
    target: [
      {
        key: 'server',
        param: 'server',
        required: false,
        describe: `ntfy server (default ${NTFY_DEFAULT_SERVER}).`,
      },
      {
        key: 'topic',
        param: 'topic',
        required: false,
        describe: 'Topic name. On a public server the topic acts as a password.',
      },
      {
        key: 'reply_topic',
        param: 'reply',
        required: false,
        describe: 'Reply topic that act buttons post to (answer from the notification).',
      },
    ],
    secrets: [
      {
        param: 'token',
        required: false,
        suggestedEnv: 'BH_NTFY_TOKEN',
        describe: 'Access token for a protected server or topic.',
      },
      {
        param: 'topic',
        required: false,
        suggestedEnv: 'BH_NTFY_TOPIC',
        describe: 'Topic name kept in a variable instead of the database.',
      },
      {
        param: 'reply_topic',
        flag: 'reply',
        required: false,
        suggestedEnv: 'BH_NTFY_REPLY_TOPIC',
        describe: 'Reply topic kept in a variable instead of the database.',
      },
      {
        param: 'reply_token',
        flag: 'replyToken',
        required: false,
        suggestedEnv: 'BH_NTFY_REPLY_TOKEN',
        describe: 'Access token that reads the reply topic (default: the channel token).',
      },
    ],
    eitherTargetOrSecret: ['topic'],
  },
  webhook: {
    kind: 'webhook',
    label: 'Webhook',
    modes: null,
    defaultMode: null,
    target: [{ key: 'url', param: 'url', required: false, describe: 'Absolute http(s) URL.' }],
    secrets: [
      {
        param: 'url',
        required: false,
        suggestedEnv: 'BH_WEBHOOK_URL',
        describe: 'The URL kept in a variable (when it contains a key).',
      },
      {
        param: 'secret',
        required: false,
        suggestedEnv: 'BH_WEBHOOK_SECRET',
        describe: 'Key of the X-BrowserHive-Signature HMAC.',
      },
    ],
    eitherTargetOrSecret: ['url'],
  },
};

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HTTP_RE = /^https?:\/\/[^\s/?#@]+(?::\d{1,5})?(?:\/[^\s?#]*)?$/i;
const TOPIC_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CHAT_RE = /^-?\d{1,20}$|^@[A-Za-z0-9_]{5,32}$/;
const THREAD_RE = /^\d{1,12}$/;
const SNOWFLAKE_RE = /^\d{15,21}$/;
const USER_ID_RE = /^\d{1,21}$/;

/**
 * Whether `value` could be a secret value typed where a variable name belongs: anything that is
 * not a plain variable name. Used to refuse, without echoing, a token pasted into a name field.
 *
 * @returns True when it is not a valid environment variable name.
 */
export function looksLikeSecretValue(value: string): boolean {
  return !ENV_NAME_RE.test(value);
}

/** A problem found in a channel configuration: which field, and a sentence that never echoes a secret. */
export interface ChannelConfigProblem {
  readonly field: string;
  readonly message: string;
}

/**
 * Checks a channel's platform configuration (not its rules). Shared by the API, the startup flag
 * parser and the dashboard, so the three refuse the same things with the same words.
 *
 * @returns Every problem (empty when valid).
 */
export function checkChannelConfig(input: {
  readonly kind: string;
  readonly mode: string | null;
  readonly target: Readonly<Record<string, string>>;
  readonly secretRefs: Readonly<Record<string, string>>;
}): ChannelConfigProblem[] {
  const problems: ChannelConfigProblem[] = [];
  const parsed = AvailableChannelKind.safeParse(input.kind);
  if (!parsed.success) {
    return [{ field: 'kind', message: `'${input.kind}' has no adapter yet.` }];
  }
  const spec = CHANNEL_KIND_SPECS[parsed.data];
  if (spec.modes === null) {
    if (input.mode !== null)
      problems.push({ field: 'mode', message: `${spec.label} has no modes.` });
  } else if (input.mode !== null && !spec.modes.includes(input.mode)) {
    problems.push({ field: 'mode', message: `mode must be one of: ${spec.modes.join(', ')}.` });
  }
  const requested = input.mode ?? spec.defaultMode;
  // An invalid mode is reported once; the per-mode checks then do not apply.
  const mode = requested !== null && spec.modes?.includes(requested) ? requested : null;
  const inMode = (owner: string | undefined) =>
    owner === undefined || mode === null || owner === mode;
  const targetKeys = new Set(spec.target.map((t) => t.key));
  for (const key of Object.keys(input.target)) {
    if (!targetKeys.has(key)) {
      problems.push({ field: `target.${key}`, message: `unknown ${spec.label} setting '${key}'.` });
    }
    const owner = spec.target.find((t) => t.key === key)?.mode;
    if (!inMode(owner) && (input.target[key] ?? '') !== '') {
      problems.push({
        field: `target.${key}`,
        message: `${key} belongs to ${owner} mode; remove it in ${mode} mode.`,
      });
    }
  }
  const secretParams = new Set(spec.secrets.map((s) => s.param));
  for (const [param, env] of Object.entries(input.secretRefs)) {
    if (!secretParams.has(param)) {
      problems.push({
        field: `secret_refs.${param}`,
        message: `unknown ${spec.label} secret '${param}'.`,
      });
      continue;
    }
    const owner = spec.secrets.find((s) => s.param === param)?.mode;
    if (!inMode(owner)) {
      problems.push({
        field: `secret_refs.${param}`,
        message: `${param} belongs to ${owner} mode; remove it in ${mode} mode.`,
      });
      continue;
    }
    if (looksLikeSecretValue(env)) {
      problems.push({
        field: `secret_refs.${param}`,
        message: `${param} must name an environment variable (letters, digits and _), never contain the secret.`,
      });
    } else if (env.startsWith(RESERVED_ENV_PREFIX)) {
      problems.push({
        field: `secret_refs.${param}`,
        message: `${param}: names starting with ${RESERVED_ENV_PREFIX} are reserved for configuration.`,
      });
    }
  }
  for (const t of spec.target) {
    if (
      t.required &&
      (t.mode === undefined || t.mode === mode) &&
      (input.target[t.key] ?? '') === ''
    ) {
      problems.push({ field: `target.${t.key}`, message: `${t.key} is required.` });
    }
  }
  for (const s of spec.secrets) {
    if (
      s.required &&
      (s.mode === undefined || s.mode === mode) &&
      input.secretRefs[s.param] === undefined
    ) {
      problems.push({
        field: `secret_refs.${s.param}`,
        message: `${s.param} is required (the name of the variable that holds it).`,
      });
    }
  }
  for (const key of spec.eitherTargetOrSecret) {
    const literal = (input.target[key] ?? '') !== '';
    const fromEnv = input.secretRefs[key] !== undefined;
    if (literal === fromEnv) {
      problems.push({
        field: `target.${key}`,
        message: literal
          ? `${key} is given both literally and as a variable; keep one.`
          : `${key} is required (literally, or as a variable).`,
      });
    }
  }
  const t = input.target;
  if (parsed.data === 'telegram') {
    if (t['chat_id'] !== undefined && t['chat_id'] !== '' && !CHAT_RE.test(t['chat_id'])) {
      problems.push({
        field: 'target.chat_id',
        message: 'chat_id must be a number like -1001234567890.',
      });
    }
    if (t['thread_id'] !== undefined && !THREAD_RE.test(t['thread_id'])) {
      problems.push({ field: 'target.thread_id', message: 'thread_id must be a number.' });
    }
  }
  if (parsed.data === 'discord') {
    for (const key of ['channel_id', 'guild_id']) {
      const value = t[key];
      if (value !== undefined && value !== '' && !SNOWFLAKE_RE.test(value)) {
        problems.push({ field: `target.${key}`, message: `${key} must be a Discord id (digits).` });
      }
    }
  }
  if (parsed.data === 'ntfy') {
    if (t['server'] !== undefined && !HTTP_RE.test(t['server'])) {
      problems.push({ field: 'target.server', message: 'server must be an absolute http(s) URL.' });
    }
    for (const key of ['topic', 'reply_topic']) {
      const value = t[key];
      if (value !== undefined && value !== '' && !TOPIC_RE.test(value)) {
        problems.push({
          field: `target.${key}`,
          message: `${key} may contain letters, digits, _ and - (up to 64).`,
        });
      }
    }
    if (t['reply_topic'] !== undefined && input.secretRefs['reply_topic'] !== undefined) {
      problems.push({
        field: 'target.reply_topic',
        message: 'reply_topic is given both literally and as a variable; keep one.',
      });
    }
    if (
      t['reply_topic'] !== undefined &&
      t['reply_topic'] !== '' &&
      t['reply_topic'] === t['topic']
    ) {
      problems.push({
        field: 'target.reply_topic',
        message: 'the reply topic must differ from the topic notifications are sent to.',
      });
    }
  }
  if (parsed.data === 'webhook' && t['url'] !== undefined && t['url'] !== '') {
    if (!/^https?:\/\//i.test(t['url'])) {
      problems.push({ field: 'target.url', message: 'url must use http: or https:.' });
    } else if (!HTTP_RE.test(t['url'].replace(/\?.*$/, ''))) {
      problems.push({ field: 'target.url', message: 'url must be an absolute http(s) URL.' });
    }
  }
  return problems;
}

/**
 * Whether a channel's setup can receive act-button presses (D-41, D-42): Telegram always, Discord in
 * bot mode, ntfy with a reply topic (literal or from a variable), the generic webhook (it carries the
 * `act` actions without tokens). The rules' `act_buttons` switch decides whether they are used.
 *
 * @returns True when act buttons can be switched on.
 */
export function supportsActButtons(input: {
  readonly kind: string;
  readonly mode: string | null;
  readonly target: Readonly<Record<string, string>>;
  readonly secretRefs: Readonly<Record<string, string>>;
}): boolean {
  switch (input.kind) {
    case 'telegram':
    case 'webhook':
      return true;
    case 'discord':
      return (input.mode ?? 'webhook') === 'bot';
    case 'ntfy':
      return (
        (input.target['reply_topic'] ?? '') !== '' || input.secretRefs['reply_topic'] !== undefined
      );
    default:
      return false;
  }
}

/** Whether presses are made by identified platform users (Telegram and Discord), so an allow-list applies. */
export function hasPresserIdentity(kind: string): boolean {
  return kind === 'telegram' || kind === 'discord';
}

/**
 * Checks the act-button rules of a channel (D-41): the switch only where presses can arrive, and
 * an allow-list of numeric platform user ids only where pressers are identified. Shared by the
 * API, the startup flag parser and the dashboard.
 *
 * @returns Every problem (empty when valid).
 */
export function checkChannelRules(input: {
  readonly kind: string;
  readonly mode: string | null;
  readonly target: Readonly<Record<string, string>>;
  readonly secretRefs: Readonly<Record<string, string>>;
  readonly rules: NotificationChannelRules;
}): ChannelConfigProblem[] {
  const problems: ChannelConfigProblem[] = [];
  if (input.rules.act_buttons === true && !supportsActButtons(input)) {
    problems.push({
      field: 'rules.act_buttons',
      message:
        input.kind === 'discord'
          ? 'act buttons need Discord bot mode; webhook messages can only carry links.'
          : input.kind === 'ntfy'
            ? 'act buttons on ntfy need a reply topic for the buttons to post to.'
            : `${input.kind} cannot receive button presses.`,
    });
  }
  const allow = input.rules.allow_list ?? [];
  if (allow.length > 0 && !hasPresserIdentity(input.kind)) {
    problems.push({
      field: 'rules.allow_list',
      message: `${input.kind} presses carry no user identity, so an allow-list does not apply.`,
    });
  } else {
    for (const id of allow) {
      if (!USER_ID_RE.test(id)) {
        problems.push({
          field: 'rules.allow_list',
          message: `'${id.slice(0, 24)}' is not a user id (digits only).`,
        });
      }
    }
  }
  return problems;
}

/** What an act-button outcome means, in one sentence (the Actions view, D-41). */
export const ACTION_OUTCOME_TEXT: Readonly<Record<string, string>> = {
  done: 'The command ran.',
  failed: 'The command ran and failed.',
  not_allowed: "The person who pressed is not on the channel's allow-list.",
  used: 'The button had already been used.',
  expired: 'The button had expired (buttons work for 24 hours).',
  stale: 'The request was no longer waiting (answered, timed out or cancelled).',
  wrong_channel: 'The button was pressed somewhere other than the channel it was sent to.',
  disabled: 'Act buttons were off, or the channel was paused, when it was pressed.',
};

/** Sample notifications the preview renders (spec 03 §4.8.1). */
export const PREVIEW_SAMPLES = [
  'attention',
  'attention-resolved',
  'vault-confirm',
  'tool-errors',
  'crash',
  'degraded',
  'test',
] as const;
/** A preview sample. */
export const PreviewSample = z.enum(PREVIEW_SAMPLES);
/** A preview sample. */
export type PreviewSample = z.infer<typeof PreviewSample>;

/** Human labels of the preview samples. */
export const PREVIEW_SAMPLE_LABEL: { readonly [S in PreviewSample]: string } = {
  attention: 'Attention requested',
  'attention-resolved': 'Attention resolved',
  'vault-confirm': 'Vault fill to confirm',
  'tool-errors': 'Tool errors',
  crash: 'Session crashed',
  degraded: 'System degraded',
  test: 'Test message',
};

/** Presets of the setup wizard (spec 04 §12.11.1). */
export const CHANNEL_PRESETS: readonly {
  readonly id: string;
  readonly label: string;
  readonly describe: string;
  readonly categories: readonly NotificationCategory[] | null;
}[] = [
  {
    id: 'needs-me',
    label: 'Needs me now',
    describe: 'Attention requests and vault fills waiting for you.',
    categories: ['needs-you'],
  },
  {
    id: 'problems',
    label: 'Problems',
    describe: 'Everything that needs you, plus crashes, reaped sessions and tool errors.',
    categories: ['needs-you', 'problems'],
  },
  {
    id: 'wrap-ups',
    label: 'Wrap-ups',
    describe: 'Finished sessions and completed fills (quiet, informational).',
    categories: ['wrap-ups'],
  },
  {
    id: 'everything',
    label: 'Everything',
    describe: 'Every notification BrowserHive produces.',
    categories: null,
  },
];

/**
 * What a delivery-log reason means, in one sentence (the "why wasn't this sent?" view). Dynamic
 * reasons (`backlog:N`, an error code on `dead`) are handled by {@link deliveryReasonText}.
 */
export const DELIVERY_REASON_TEXT: Readonly<Record<string, string>> = {
  filtered:
    "The channel's rules (category, severity, session or harness) exclude this notification.",
  quiet_hours: 'It arrived during the quiet hours of the channel and was not urgent.',
  throttled: 'Too many messages in a short time; it was held back.',
  channel_paused: 'The channel was paused (or broken) when this was due.',
  content_blocked: "The channel's content level does not allow this notification.",
  image_blocked: 'The screenshot was not allowed on this channel; the text was sent without it.',
  edit_unsupported: 'The platform cannot edit messages, and this change was silent.',
  delete_unsupported: 'The platform cannot delete messages.',
  no_adapter: 'The channel could not be started (for example, a variable it needs is not set).',
  covered: 'A newer version of the same notification was already delivered.',
  not_sent: 'The first message was never sent, so there was nothing to edit.',
  message_deleted: 'The message had already been deleted.',
  message_gone: 'The message was deleted in the chat, so it could not be edited.',
  collapsed: 'Too many messages were waiting; they were folded into one "you missed N" message.',
  channel_gone: 'The channel was deleted.',
  no_message: 'The notification has no message to send (it predates channels).',
  max_attempts: 'Every retry failed (8 attempts).',
  expired: 'It could not be delivered within 24 hours.',
  'could_not_delete: too_old':
    'Telegram lets a bot delete messages for 48 hours only; this one was older.',
  rate_limited: 'The platform asked BrowserHive to slow down; it will retry.',
  unavailable: 'The platform could not be reached; it will retry.',
  timeout: 'The platform did not answer in time; it will retry.',
  auth: 'The platform refused the credentials (a wrong or revoked token or URL).',
  rejected: 'The platform refused the message.',
  test: 'A test message sent from the dashboard or the CLI.',
};

/**
 * One sentence for a delivery row's reason.
 *
 * @returns The explanation, or `null` without a reason.
 */
export function deliveryReasonText(reason: string | null): string | null {
  if (reason === null || reason === '') return null;
  const known = DELIVERY_REASON_TEXT[reason];
  if (known !== undefined) return known;
  if (reason.startsWith('backlog:')) {
    const n = reason.slice('backlog:'.length);
    return `Sent with a note that ${n} earlier notifications were folded into it.`;
  }
  return reason;
}

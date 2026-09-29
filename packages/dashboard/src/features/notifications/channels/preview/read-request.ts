/** @module features/notifications/channels/preview/read-request — tolerant readers that turn a renderer's `PlatformRequest` (JSON, multipart fields or query fields; objects or JSON strings) into what each platform mock draws. Pure; unknown shapes degrade to empty values instead of throwing. */
import type { PlatformRequest } from '@browserhive/contracts/http';

type Json = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A value that may arrive as JSON text (multipart fields are strings). */
function parsed(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return value;
  try {
    return JSON.parse(t);
  } catch {
    return value;
  }
}

function str(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return null;
}

function arr(value: unknown): readonly unknown[] {
  const v = parsed(value);
  return Array.isArray(v) ? v : [];
}

/** One button of a message. */
export interface MockButton {
  readonly label: string;
  /** A link button's URL; `null` for an act (callback) button. */
  readonly url: string | null;
  /** `primary`, `danger`, `success`, `secondary` or `link`. */
  readonly style: 'primary' | 'danger' | 'success' | 'secondary' | 'link';
}

/** What the Telegram mock draws. */
export interface TelegramView {
  readonly html: string;
  readonly photo: { readonly name: string } | null;
  readonly rows: readonly (readonly MockButton[])[];
  readonly silent: boolean;
  readonly reply: boolean;
  readonly edit: boolean;
  readonly method: string;
}

/** Reads a Telegram `sendMessage` / `sendPhoto` / edit request. */
export function readTelegram(request: PlatformRequest): TelegramView {
  const body = request.body;
  const text = str(body['text']) ?? str(body['caption']) ?? '';
  const markup = parsed(body['reply_markup']);
  const keyboard = isRecord(markup) ? arr(markup['inline_keyboard']) : [];
  const rows = keyboard.map((row) =>
    arr(row).flatMap((b): MockButton[] => {
      if (!isRecord(b)) return [];
      const label = str(b['text']) ?? '';
      const url = str(b['url']);
      return [{ label, url, style: url === null ? 'secondary' : 'link' }];
    }),
  );
  const method = request.path.replace(/^\//, '');
  return {
    html: text,
    photo:
      request.file !== null || method === 'sendPhoto' || method === 'editMessageCaption'
        ? { name: request.file?.name ?? 'screenshot.jpg' }
        : null,
    rows: rows.filter((r) => r.length > 0),
    silent: body['disable_notification'] === true || body['disable_notification'] === 'true',
    reply: body['reply_parameters'] !== undefined || body['reply_to_message_id'] !== undefined,
    edit: method.startsWith('edit'),
    method,
  };
}

/** One Discord embed field. */
export interface DiscordField {
  readonly name: string;
  readonly value: string;
  readonly inline: boolean;
}

/** One Discord embed. */
export interface DiscordEmbed {
  readonly title: string | null;
  readonly url: string | null;
  readonly description: string | null;
  /** RGB integer from the payload, or `null`. */
  readonly color: number | null;
  readonly fields: readonly DiscordField[];
  readonly image: string | null;
  readonly footer: string | null;
  readonly timestamp: string | null;
}

/** What the Discord mock draws. */
export interface DiscordView {
  readonly content: string | null;
  readonly embeds: readonly DiscordEmbed[];
  readonly rows: readonly (readonly MockButton[])[];
  readonly edit: boolean;
  readonly attachment: string | null;
}

const DISCORD_STYLE: Readonly<Record<number, MockButton['style']>> = {
  1: 'primary',
  2: 'secondary',
  3: 'success',
  4: 'danger',
  5: 'link',
};

/** Reads a Discord webhook execute/edit request (JSON, or multipart with `payload_json`). */
export function readDiscord(request: PlatformRequest): DiscordView {
  const payload = parsed(request.body['payload_json']);
  const body: Json = isRecord(payload) ? payload : request.body;
  const embeds = arr(body['embeds']).flatMap((e): DiscordEmbed[] => {
    if (!isRecord(e)) return [];
    const image = isRecord(e['image']) ? str(e['image']['url']) : null;
    const footer = isRecord(e['footer']) ? str(e['footer']['text']) : null;
    return [
      {
        title: str(e['title']),
        url: str(e['url']),
        description: str(e['description']),
        color: typeof e['color'] === 'number' ? e['color'] : null,
        fields: arr(e['fields']).flatMap((f): DiscordField[] =>
          isRecord(f)
            ? [
                {
                  name: str(f['name']) ?? '',
                  value: str(f['value']) ?? '',
                  inline: f['inline'] === true,
                },
              ]
            : [],
        ),
        image,
        footer,
        timestamp: str(e['timestamp']),
      },
    ];
  });
  const rows = arr(body['components']).map((row) =>
    isRecord(row)
      ? arr(row['components']).flatMap((b): MockButton[] => {
          if (!isRecord(b)) return [];
          const style =
            typeof b['style'] === 'number'
              ? (DISCORD_STYLE[b['style']] ?? 'secondary')
              : 'secondary';
          return [{ label: str(b['label']) ?? '', url: str(b['url']), style }];
        })
      : [],
  );
  return {
    content: str(body['content']),
    embeds,
    rows: rows.filter((r) => r.length > 0),
    edit: request.method.toUpperCase() === 'PATCH',
    attachment: request.file?.name ?? null,
  };
}

/** One ntfy action button. */
export interface NtfyAction {
  readonly label: string;
  readonly url: string | null;
  readonly kind: string;
}

/** What the ntfy mock draws. */
export interface NtfyView {
  readonly topic: string | null;
  readonly title: string | null;
  readonly message: string;
  readonly priority: number;
  readonly tags: readonly string[];
  readonly click: string | null;
  readonly actions: readonly NtfyAction[];
  readonly attachment: string | null;
  readonly sequence: string | null;
}

const PRIORITY_NAMES: Readonly<Record<string, number>> = {
  min: 1,
  low: 2,
  default: 3,
  high: 4,
  max: 5,
  urgent: 5,
};

function header(request: PlatformRequest, ...names: readonly string[]): string | null {
  for (const [key, value] of Object.entries(request.headers)) {
    if (names.includes(key.toLowerCase())) return value;
  }
  return null;
}

function field(request: PlatformRequest, key: string, ...headers: readonly string[]): unknown {
  const value = request.body[key];
  return value !== undefined ? value : header(request, ...headers);
}

/** `view, Open, https://…, clear=true; http, …` → actions. */
function parseActionText(text: string): NtfyAction[] {
  return text
    .split(';')
    .map((a) => a.split(',').map((p) => p.trim()))
    .filter((parts) => parts.length >= 2)
    .map((parts) => ({
      kind: parts[0] ?? 'view',
      label: parts[1] ?? '',
      url: parts[2] !== undefined && !parts[2].includes('=') ? parts[2] : null,
    }));
}

/** Reads an ntfy publish (JSON on `/`, or a file body with fields as query parameters or headers). */
export function readNtfy(request: PlatformRequest): NtfyView {
  const rawPriority = field(request, 'priority', 'x-priority', 'priority', 'prio', 'p');
  const priority =
    typeof rawPriority === 'number'
      ? rawPriority
      : typeof rawPriority === 'string'
        ? (PRIORITY_NAMES[rawPriority] ?? (Number(rawPriority) || 3))
        : 3;
  const rawTags = field(request, 'tags', 'x-tags', 'tags', 'tag', 'ta');
  const tags = Array.isArray(rawTags)
    ? rawTags.map(String)
    : typeof rawTags === 'string'
      ? rawTags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
      : [];
  const rawActions = parsed(field(request, 'actions', 'x-actions', 'actions', 'action'));
  const actions = Array.isArray(rawActions)
    ? rawActions.flatMap((a): NtfyAction[] =>
        isRecord(a)
          ? [{ kind: str(a['action']) ?? 'view', label: str(a['label']) ?? '', url: str(a['url']) }]
          : [],
      )
    : typeof rawActions === 'string'
      ? parseActionText(rawActions)
      : [];
  const pathTopic = request.path.replace(/^\/+/, '').split('/')[0] ?? '';
  return {
    topic: str(request.body['topic']) ?? (pathTopic === '' ? null : pathTopic),
    title: str(field(request, 'title', 'x-title', 'title', 't')),
    message: str(field(request, 'message', 'x-message', 'message', 'm')) ?? '',
    priority: Math.min(5, Math.max(1, priority)),
    tags,
    click: str(field(request, 'click', 'x-click', 'click')),
    actions,
    attachment:
      request.file?.name ??
      str(field(request, 'filename', 'x-filename', 'filename')) ??
      (field(request, 'attach', 'x-attach', 'attach') !== undefined &&
      field(request, 'attach', 'x-attach', 'attach') !== null
        ? 'attachment'
        : null),
    sequence: str(field(request, 'sequence_id', 'x-sequence-id')),
  };
}

/** ntfy tag short codes BrowserHive uses, as the emoji the app shows before the title. */
export const NTFY_EMOJI: Readonly<Record<string, string>> = {
  information_source: 'ℹ️',
  warning: '⚠️',
  rotating_light: '🚨',
  sos: '🆘',
  white_check_mark: '✅',
  heavy_check_mark: '✔️',
  x: '❌',
  lock: '🔒',
  camera: '📷',
  bell: '🔔',
  robot: '🤖',
  hourglass: '⌛',
  wave: '👋',
  test_tube: '🧪',
};

/** Splits ntfy tags into the emoji shown before the title and the plain tags listed below it. */
export function splitNtfyTags(tags: readonly string[]): {
  readonly emoji: readonly string[];
  readonly plain: readonly string[];
} {
  const emoji: string[] = [];
  const plain: string[] = [];
  for (const tag of tags) {
    const e = NTFY_EMOJI[tag];
    if (e !== undefined) emoji.push(e);
    else plain.push(tag);
  }
  return { emoji, plain };
}

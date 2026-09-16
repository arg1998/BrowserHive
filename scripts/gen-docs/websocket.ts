/** @module scripts/gen-docs/websocket — renders docs/reference/websocket.md from the contracts WS protocol */
import { formatBytes, formatDuration } from '@browserhive/contracts/config';
import { API_PREFIX } from '@browserhive/contracts/http';
import {
  LiveInput,
  SCREENCAST_HEADER_BYTES,
  SCREENCAST_HEADER_LAYOUT,
  SCREENCAST_MAGIC,
  ScreencastControl,
  WS_CLOSE,
  WS_COMMAND_SCOPES,
  WS_LIMITS,
  WS_PATH,
  WS_PROTOCOL_VERSION,
  WS_SESSION_TOPIC_EVENTS,
  WS_STATIC_TOPICS,
  WS_SUBPROTOCOL,
  WS_TOPIC_EVENTS,
  WS_TOPIC_SCOPES,
  WsClientCommand,
  WsFeedEvent,
  WsKind,
  WsReplyPayload,
} from '@browserhive/contracts/ws';
import { z } from 'zod';
import {
  anchor,
  describeConstraints,
  describeType,
  document,
  GENERATED_HEADER,
  inlineCode,
  isRecord,
  objectFields,
  table,
} from './markdown.ts';

const CLOSE_TEXT: Readonly<Record<keyof typeof WS_CLOSE, string>> = {
  UNAUTHORIZED: 'not authenticated or the session expired; log in again',
  PASSWORD_CHANGE_REQUIRED: 'the operator must change the password first',
  PROTOCOL_ERROR: 'too many malformed frames',
  BAD_SUBPROTOCOL: `missing or unknown \`Sec-WebSocket-Protocol\` (expected \`${WS_SUBPROTOCOL}\`)`,
  OVERLOADED: 'the client did not read fast enough (backpressure limit exceeded)',
  GOING_AWAY: 'server shutting down, or the socket was silent too long',
};

const KIND_TEXT: Readonly<Record<WsKind, string>> = {
  event: 'ordered, replayable feed event on a topic (has `topic` and `seq`)',
  reply: 'answer to a client command (echoes `corr`); also the first `hello` frame',
  error: 'command failure or protocol violation; the socket stays open',
  stream: 'screencast control message on `screencast:<id>`; latest-wins, never replayed',
};

interface Member {
  readonly type: string;
  readonly schema: unknown;
}

function members(options: readonly z.ZodType[], io: 'input' | 'output'): Member[] {
  return options.map((option) => {
    const schema = z.toJSONSchema(option, { io, unrepresentable: 'any' });
    const props = isRecord(schema) ? schema['properties'] : undefined;
    const typeNode = isRecord(props) ? props['type'] : undefined;
    const type = isRecord(typeNode) ? String(typeNode['const']) : '?';
    return { type, schema };
  });
}

function fieldsText(schema: unknown, skip: readonly string[] = ['type']): string {
  const fields = objectFields(schema).filter((f) => !skip.includes(f.name));
  if (fields.length === 0) return '—';
  return fields
    .map((f) => `${inlineCode(f.required ? f.name : `${f.name}?`)}: ${describeType(f.schema)}`)
    .join(', ');
}

function fieldTable(schema: unknown): string {
  return table(
    ['Field', 'Type', 'Required', 'Constraints'],
    objectFields(schema).map((f) => [
      inlineCode(f.name),
      describeType(f.schema),
      f.required ? 'yes' : 'no',
      describeConstraints(f.schema).join('; ') || '—',
    ]),
  );
}

function limitValue(name: string, value: number): string {
  if (name.endsWith('Bytes')) return formatBytes(value);
  if (name.endsWith('Ms')) return formatDuration(value);
  return String(value);
}

function topicScope(topic: string): string {
  const scopes: Readonly<Record<string, string>> = WS_TOPIC_SCOPES;
  return inlineCode(scopes[topic] ?? '—');
}

/**
 * Render `docs/reference/websocket.md`.
 *
 * @returns The Markdown document.
 */
export function renderWebsocket(): string {
  const commands = members(WsClientCommand.options, 'input');
  const events = members(WsFeedEvent.options, 'output');
  const replies = members(WsReplyPayload.options, 'output');
  const stream = members(ScreencastControl.options, 'output');
  const inputs = members(LiveInput.options, 'input');
  const eventLinks = (types: readonly string[]): string =>
    types.map((t) => `[${inlineCode(t)}](#event-${t.replace(/\./g, '-')})`).join(', ');

  return document([
    GENERATED_HEADER,
    '# WebSocket reference',
    `Realtime protocol v${WS_PROTOCOL_VERSION} used by the dashboard for live feeds, the screencast and takeover input. Generated from \`@browserhive/contracts/ws\`. Available when \`--admin\` is on.`,
    '## Handshake',
    [
      `- URL: \`ws://<host>:<port>${API_PREFIX}${WS_PATH}\` (same port as everything else).`,
      `- Subprotocol: \`Sec-WebSocket-Protocol: ${WS_SUBPROTOCOL}\`.`,
      '- Authentication: the dashboard session cookie or `Authorization: Bearer <token>`, checked at upgrade. A failed check completes the upgrade and closes immediately with `4401`, so browsers see the code.',
      '- The first server frame is a `reply` with payload `type: "hello"`, carrying `epoch` and the current `cursor`. `epoch` changes on every server start; a cursor from another epoch cannot be replayed.',
    ].join('\n'),
    '## Envelope',
    'Every server text frame is JSON:',
    '```ts\n{ v: 1, kind: "event" | "reply" | "error" | "stream", seq: number, ts: number, topic?: string, corr?: string, payload: unknown }\n```',
    table(
      ['kind', 'Meaning'],
      WsKind.options.map((k) => [inlineCode(k), KIND_TEXT[k]]),
    ),
    'Client frames are JSON objects discriminated on `type` (see [client commands](#client-commands)); any command may carry `corr` (1–64 characters), which is echoed on its reply or error.',
    '## Limits',
    table(
      ['Limit', 'Value'],
      Object.entries(WS_LIMITS).map(([name, value]) => [inlineCode(name), limitValue(name, value)]),
    ),
    '## Close codes',
    table(
      ['Code', 'Name', 'Meaning'],
      Object.entries(CLOSE_TEXT).map(([name, text]) => {
        const codes: Readonly<Record<string, number>> = WS_CLOSE;
        return [String(codes[name]), inlineCode(name), text];
      }),
    ),
    '## Client commands',
    table(
      ['type', 'Fields', 'Scope'],
      commands.map((c) => {
        const scopes: Readonly<Record<string, string | null>> = WS_COMMAND_SCOPES;
        const scope = scopes[c.type];
        return [
          inlineCode(c.type),
          fieldsText(c.schema, ['type', 'corr']),
          scope === null || scope === undefined ? 'any authenticated caller' : inlineCode(scope),
        ];
      }),
    ),
    '`input` is accepted only while an attention request is open for the session and is re-checked on every message (`INPUT_NOT_PERMITTED` otherwise). `session.set_viewport` is an observability control and is not attention-gated.',
    '### Takeover input (`LiveInput`)',
    'Field names follow the Chrome DevTools Protocol (camelCase). `modifiers` is a bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8.',
    ...inputs.map((i) => [`#### ${inlineCode(i.type)}`, '', fieldTable(i.schema)].join('\n')),
    '## Replies',
    table(
      ['payload type', 'Fields'],
      replies.map((r) => [inlineCode(r.type), fieldsText(r.schema)]),
    ),
    '## Topics',
    'Subscribe with `{ "type": "subscribe", "topic": "<topic>", "cursor"?: <last seq> }`. The reply `subscribed { from, to, complete }` says whether the replay was complete; `complete: false` (or `resync_required`) means reload from REST.',
    table(
      ['Topic', 'Scope', 'Events'],
      [
        ...WS_STATIC_TOPICS.map((topic) => [
          inlineCode(topic),
          topicScope(topic),
          eventLinks(WS_TOPIC_EVENTS[topic]),
        ]),
        [inlineCode('session:<id>'), topicScope('session'), eventLinks(WS_SESSION_TOPIC_EVENTS)],
        [
          inlineCode('screencast:<id>'),
          topicScope('screencast'),
          `stream messages ${stream.map((s) => inlineCode(s.type)).join(', ')} and binary frames`,
        ],
      ],
    ),
    '## Feed events',
    'Payloads of `kind: "event"` frames, discriminated on `type`. DTO fields (`session`, `row`, `request`, …) are the same shapes the REST API returns.',
    ...events.map((e) =>
      [
        anchor(`event-${e.type.replace(/\./g, '-')}`),
        `### ${inlineCode(e.type)}`,
        '',
        fieldTable({
          ...(isRecord(e.schema) ? e.schema : {}),
          properties: Object.fromEntries(
            objectFields(e.schema)
              .filter((f) => f.name !== 'type')
              .map((f) => [f.name, f.schema]),
          ),
        }),
      ].join('\n'),
    ),
    '## Screencast',
    "Start with `screencast.start { session_id, max_width?, max_height?, quality? }`; the reply `screencast.started` carries the `ordinal` that tags this screencast's binary frames. Frames are latest-wins and dropped under backpressure; each viewer may request its own size with `screencast.set_size`.",
    '### Stream control messages',
    table(
      ['type', 'Fields'],
      stream.map((s) => [inlineCode(s.type), fieldsText(s.schema)]),
    ),
    '### Binary frame header',
    `Each binary frame is a ${SCREENCAST_HEADER_BYTES}-byte big-endian header followed by the JPEG bytes.`,
    table(
      ['Offset', 'Field', 'Encoding'],
      Object.entries(SCREENCAST_HEADER_LAYOUT).map(([field, offset]) => {
        const encoding: Readonly<Record<string, string>> = {
          magic: `4 ASCII bytes ${inlineCode(SCREENCAST_MAGIC)}`,
          ordinal: 'u32',
          seq: 'u32 (monotonic per screencast; a lower seq after a higher one is dropped)',
          width: 'u16 (JPEG width)',
          height: 'u16 (JPEG height)',
        };
        return [String(offset), inlineCode(field), encoding[field] ?? '—'];
      }),
    ),
  ]);
}

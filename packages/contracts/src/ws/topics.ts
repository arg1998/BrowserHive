/** @module contracts/ws/topics — topic names (1:1 with REST resources) and their parsers (D-10, spec 03 §6.6) */
import { z } from 'zod';
import { SESSION_ID_RE, SessionId } from '../ids/index.ts';

/** Static (non-parameterised) topics. */
export const WS_STATIC_TOPICS = [
  'sessions',
  'attention',
  'vault.confirm',
  'vault.config',
  'vault.access',
  'pages',
  'blocklist',
  'system',
  'logs',
  'notifications',
] as const;
/** Static topic name. */
export type WsStaticTopic = (typeof WS_STATIC_TOPICS)[number];
/** Static topic schema. */
export const WsStaticTopic = z.enum(WS_STATIC_TOPICS);

/** Session id grammar without anchors, for embedding in topic regexes. */
const sessionIdBody = SESSION_ID_RE.source.slice(1, -1);
/** `session:<id>` topic grammar. */
export const SESSION_TOPIC_RE = new RegExp(`^session:${sessionIdBody}$`);
/** `screencast:<id>` topic grammar. */
export const SCREENCAST_TOPIC_RE = new RegExp(`^screencast:${sessionIdBody}$`);

/** Any valid topic string (static, `session:<id>` or `screencast:<id>`). */
export const WsTopic = z
  .string()
  .max(160)
  .refine(
    (t) =>
      (WS_STATIC_TOPICS as readonly string[]).includes(t) ||
      SESSION_TOPIC_RE.test(t) ||
      SCREENCAST_TOPIC_RE.test(t),
    { message: 'unknown topic' },
  );
/** Any valid topic string. */
export type WsTopic = z.infer<typeof WsTopic>;

/** Topic carrying everything about one session (feed events scoped to that id). */
export function sessionTopic(id: SessionId): WsTopic {
  return `session:${id}`;
}

/** Topic carrying screencast control messages and binary frames for one session. */
export function screencastTopic(id: SessionId): WsTopic {
  return `screencast:${id}`;
}

/** Parsed topic, discriminated on `kind`. */
export type ParsedTopic =
  | { readonly kind: 'static'; readonly name: WsStaticTopic }
  | { readonly kind: 'session'; readonly session_id: SessionId }
  | { readonly kind: 'screencast'; readonly session_id: SessionId };

/** Parse a topic string; `null` when it is not a valid topic. Never throws. */
export function parseTopic(topic: string): ParsedTopic | null {
  const stat = WsStaticTopic.safeParse(topic);
  if (stat.success) return { kind: 'static', name: stat.data };
  const colon = topic.indexOf(':');
  if (colon < 0) return null;
  const prefix = topic.slice(0, colon);
  const id = SessionId.safeParse(topic.slice(colon + 1));
  if (!id.success) return null;
  if (prefix === 'session') return { kind: 'session', session_id: id.data };
  if (prefix === 'screencast') return { kind: 'screencast', session_id: id.data };
  return null;
}

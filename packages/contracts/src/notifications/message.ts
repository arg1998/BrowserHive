/** @module contracts/notifications/message — `NotificationMessage`, the versioned, producer-owned notification contract every channel renders (D-32, spec 03 §9.2). Platform-neutral and JSON-serialisable; snake_case on the wire (D-05). */

import { z } from 'zod';
import { NotificationCategory } from '../enums/notification-category.ts';
import { NotificationCommandOp } from '../enums/notification-command-op.ts';
import { NotificationContentLevel } from '../enums/notification-content-level.ts';
import { NotificationKind } from '../enums/notification-kind.ts';
import { NotificationSeverity } from '../enums/notification-severity.ts';
import { NotificationState } from '../enums/notification-state.ts';
import { EpochMs } from '../http/common.ts';
import { NOTIFICATION_ID_RE } from '../ids/ids.ts';

/** Contract version carried in every message as `schema`. Additive changes keep it; a breaking change bumps it (D-32). */
export const NOTIFICATION_SCHEMA_VERSION = 1;
/** Maximum length of `title` (plain text). */
export const NOTIFICATION_TITLE_MAX = 120;
/** Maximum length of `summary` (plain text; push preview, ntfy body, fallback). */
export const NOTIFICATION_SUMMARY_MAX = 240;
/** Maximum number of `actions`, ordered by importance. */
export const NOTIFICATION_ACTIONS_MAX = 5;
/** Maximum number of `blocks`. */
export const NOTIFICATION_BLOCKS_MAX = 50;
/** Maximum length of a button or field label. */
export const NOTIFICATION_LABEL_MAX = 40;
/** Maximum length of one text leaf (an inline's text, a code block). */
export const NOTIFICATION_TEXT_MAX = 4000;

const Text = z.string().max(NOTIFICATION_TEXT_MAX);
const Label = z.string().min(1).max(NOTIFICATION_LABEL_MAX);

/**
 * A dashboard path such as `/sessions/shop-a1b2c3d4?live=1`: absolute within the dashboard, no
 * scheme or host. A `LinkBuilder` turns it into a URL (`publicUrl + path`, D-37); links never carry
 * tokens.
 */
export const DashboardPath = z
  .string()
  .max(2048)
  .regex(/^\/(?!\/)\S*$/, 'a dashboard path starting with a single /');
/** A dashboard path. */
export type DashboardPath = z.infer<typeof DashboardPath>;

/** Plain text. */
export const InlineText = z.object({ type: z.literal('text'), text: Text });
/** Strong emphasis. */
export const InlineBold = z.object({ type: z.literal('bold'), text: Text });
/** Emphasis. */
export const InlineItalic = z.object({ type: z.literal('italic'), text: Text });
/** Monospace (ids, codes, sanitized URLs). */
export const InlineCode = z.object({ type: z.literal('code'), text: Text });
/** A link to a dashboard page (never an external URL). */
export const InlineLink = z.object({ type: z.literal('link'), text: Text, path: DashboardPath });
/** A point in time a renderer may localise (`relative`: "2 min ago"; `absolute`: "14:02"). */
export const InlineTime = z.object({
  type: z.literal('time'),
  at: EpochMs,
  style: z.enum(['relative', 'absolute']),
});

/** One inline node: a tiny AST, never a markdown string (D-32). */
export const Inline = z.discriminatedUnion('type', [
  InlineText,
  InlineBold,
  InlineItalic,
  InlineCode,
  InlineLink,
  InlineTime,
]);
/** One inline node. */
export type Inline = z.infer<typeof Inline>;

/** A run of inline nodes. */
export const InlineRun = z.array(Inline).max(64);
/** A run of inline nodes. */
export type InlineRun = z.infer<typeof InlineRun>;

/** A paragraph. */
export const TextBlock = z.object({ type: z.literal('text'), content: InlineRun });
/** A section heading (plain text). */
export const HeadingBlock = z.object({ type: z.literal('heading'), text: Text });
/** Label/value facts (session, tool, error code…); kept at the `titles` content level. */
export const FieldsBlock = z.object({
  type: z.literal('fields'),
  items: z
    .array(z.object({ label: Label, value: InlineRun }))
    .min(1)
    .max(12),
});
/** Quoted text from an observed fact (an agent's attention message); may be shown collapsed. */
export const QuoteBlock = z.object({
  type: z.literal('quote'),
  content: InlineRun,
  collapsible: z.boolean(),
});
/** A bulleted or numbered list. */
export const ListBlock = z.object({
  type: z.literal('list'),
  ordered: z.boolean(),
  items: z.array(InlineRun).min(1).max(20),
});
/** A small table; `degrade` turns it into a list where tables are unsupported. */
export const TableBlock = z.object({
  type: z.literal('table'),
  columns: z.array(Label).min(1).max(8),
  rows: z.array(z.array(InlineRun)).max(20),
});
/**
 * A screenshot (D-36). `ref` is an opaque artifact reference resolved by the delivering core, never
 * by a consumer; `path` is the dashboard page that shows it (used when a channel cannot carry images).
 */
export const ImageBlock = z.object({
  type: z.literal('image'),
  ref: z.string().min(1).max(512),
  alt: Text,
  captured_at: EpochMs,
  masked: z.boolean(),
  path: DashboardPath.nullable(),
});
/** Preformatted text. */
export const CodeBlock = z.object({
  type: z.literal('code'),
  text: Text,
  language: z.string().max(32).nullable(),
});
/** A separator. */
export const DividerBlock = z.object({ type: z.literal('divider') });
/** Small print at the end (the "Open in BrowserHive" link, a "you missed N" note). */
export const FooterBlock = z.object({ type: z.literal('footer'), content: InlineRun });

/** One semantic, platform-neutral block (D-32). */
export const Block = z.discriminatedUnion('type', [
  TextBlock,
  HeadingBlock,
  FieldsBlock,
  QuoteBlock,
  ListBlock,
  TableBlock,
  ImageBlock,
  CodeBlock,
  DividerBlock,
  FooterBlock,
]);
/** One block. */
export type Block = z.infer<typeof Block>;
/** The `type` of a block. */
export type BlockType = Block['type'];

/** Visual weight of a button. */
export const ActionStyle = z.enum(['primary', 'danger', 'default']);
/** Visual weight of a button. */
export type ActionStyle = z.infer<typeof ActionStyle>;

const ActionId = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,31}$/, 'a lowercase action id')
  .describe('Stable within the message (`resolve`, `open-session`).');

/** A link button to a dashboard page (Open session, Take over, Open live view). */
export const OpenAction = z.object({
  kind: z.literal('open'),
  id: ActionId,
  label: Label,
  style: ActionStyle,
  path: DashboardPath,
});
/** A link button. */
export type OpenAction = z.infer<typeof OpenAction>;

/** A command an `act` button asks BrowserHive to run (D-32). */
export const NotificationCommand = z.object({
  op: NotificationCommandOp,
  args: z.record(z.string().max(64), z.union([z.string().max(256), z.number(), z.boolean()])),
});
/** A command. */
export type NotificationCommand = z.infer<typeof NotificationCommand>;

/**
 * A button that acts through the chat platform (Approve / Deny / Extend lease). Where a channel
 * cannot carry it, `degrade` replaces it with its `fallback` link.
 */
export const ActAction = z.object({
  kind: z.literal('act'),
  id: ActionId,
  label: Label,
  style: ActionStyle,
  command: NotificationCommand,
  /** Question to confirm before running, or `null`. */
  confirm: z.string().max(NOTIFICATION_SUMMARY_MAX).nullable(),
  fallback: z.object({ label: Label, path: DashboardPath }),
});
/** An act button. */
export type ActAction = z.infer<typeof ActAction>;

/** One action: `act` (through the platform) or `open` (a dashboard link). */
export const NotificationAction = z.discriminatedUnion('kind', [ActAction, OpenAction]);
/** One action. */
export type NotificationAction = z.infer<typeof NotificationAction>;

/** Routing input: what the notification is about. Every key is optional. */
export const NotificationEntities = z.object({
  session_id: z.string().max(128).optional(),
  session_slug: z.string().max(64).optional(),
  harness: z.string().max(64).optional(),
  owner: z.string().max(128).optional(),
  tool: z.string().max(64).optional(),
  error_code: z.string().max(64).optional(),
  domain: z.string().max(253).optional(),
  request_id: z.string().max(64).optional(),
});
/** Routing input. */
export type NotificationEntities = z.infer<typeof NotificationEntities>;

/** The content level already applied to this message, and whether it carries an image. */
export const NotificationPrivacy = z.object({
  level: NotificationContentLevel,
  has_image: z.boolean(),
});
/** Applied privacy. */
export type NotificationPrivacy = z.infer<typeof NotificationPrivacy>;

/**
 * The notification contract (D-32). Every revision is the complete state: consumers always render
 * the whole message and never merge revisions. Consumers MUST ignore kinds, blocks, inlines and
 * actions they do not know.
 */
export const NotificationMessage = z.object({
  schema: z.literal(NOTIFICATION_SCHEMA_VERSION),
  /** The notification id (`n-…`), stable for its life. */
  id: z.string().regex(NOTIFICATION_ID_RE),
  /** 1 for the first state; +1 per change. */
  revision: z.number().int().min(1),
  /** Conversation the message belongs to (`attention:<id>`, `session:<id>`, `tool-errors:<session>`). */
  thread: z.string().min(1).max(160),
  kind: NotificationKind,
  category: NotificationCategory,
  severity: NotificationSeverity,
  state: NotificationState,
  /** Whether this revision should make noise. Edits are always silent (D-34). */
  alert: z.boolean(),
  at: z.object({ created: EpochMs, updated: EpochMs }),
  title: z.string().min(1).max(NOTIFICATION_TITLE_MAX),
  summary: z.string().max(NOTIFICATION_SUMMARY_MAX),
  blocks: z.array(Block).max(NOTIFICATION_BLOCKS_MAX),
  actions: z.array(NotificationAction).max(NOTIFICATION_ACTIONS_MAX),
  entities: NotificationEntities,
  privacy: NotificationPrivacy,
});
/** The notification contract. */
export type NotificationMessage = z.infer<typeof NotificationMessage>;

/** @module infra/persistence/mappers/notification-actions — `notification_action_tokens` and `notification_actions` rows ↔ records (spec 03 §7, §9.6). */

import type { Insertable, Selectable } from 'kysely';
import { NOTIFICATION_ACTION_OUTCOMES } from '../../../ports/persistence/enums.ts';
import type {
  NewNotificationAction,
  NotificationActionRecord,
  NotificationActionTokenRecord,
} from '../../../ports/persistence/records.ts';
import type { NotificationActions, NotificationActionTokens } from '../generated/db.d.ts';
import { parseEnum, parseJsonObject } from './codec.ts';

/** A command's args: string, number and boolean leaves only. */
function argsOf(text: string, where: string): Readonly<Record<string, string | number | boolean>> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(parseJsonObject(text, where))) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}

/** `notification_action_tokens` row → record. */
export function actionTokenFromRow(
  row: Selectable<NotificationActionTokens>,
): NotificationActionTokenRecord {
  return {
    tokenHash: row.token_hash,
    channelId: row.channel_id,
    notificationId: row.notification_id,
    actionId: row.action_id,
    op: row.op,
    args: argsOf(row.args_json, `notification_action_tokens.args`),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
  };
}

/** Record → `notification_action_tokens` row. */
export function actionTokenToRow(
  record: NotificationActionTokenRecord,
): Insertable<NotificationActionTokens> {
  return {
    token_hash: record.tokenHash,
    channel_id: record.channelId,
    notification_id: record.notificationId,
    action_id: record.actionId,
    op: record.op,
    args_json: JSON.stringify(record.args),
    created_at: record.createdAt,
    expires_at: record.expiresAt,
    used_at: record.usedAt,
  };
}

/** `notification_actions` row → record. */
export function actionFromRow(row: Selectable<NotificationActions>): NotificationActionRecord {
  const where = `notification_actions.${row.seq}`;
  return {
    seq: Number(row.seq),
    at: row.at,
    channelId: row.channel_id,
    channelName: row.channel_name,
    channelKind: row.channel_kind,
    notificationId: row.notification_id,
    actionId: row.action_id,
    actionLabel: row.action_label,
    op: row.op,
    args: argsOf(row.args_json, `${where}.args`),
    actor: row.actor,
    actorName: row.actor_name,
    outcome: parseEnum(NOTIFICATION_ACTION_OUTCOMES, row.outcome, `${where}.outcome`),
    detail: row.detail,
  };
}

/** New press → `notification_actions` row. */
export function actionToRow(row: NewNotificationAction): Insertable<NotificationActions> {
  return {
    at: row.at,
    channel_id: row.channelId,
    channel_name: row.channelName,
    channel_kind: row.channelKind,
    notification_id: row.notificationId,
    action_id: row.actionId,
    action_label: row.actionLabel,
    op: row.op,
    args_json: JSON.stringify(row.args),
    actor: row.actor,
    actor_name: row.actorName,
    outcome: row.outcome,
    detail: row.detail,
  };
}

/** @module contracts/notifications/json-schema — the published JSON Schema (draft 2020-12) of `NotificationMessage`, generated from the zod schema into `docs/reference/notification-message.schema.json` (D-32). */

import { z } from 'zod';
import { NOTIFICATION_SCHEMA_VERSION, NotificationMessage } from './message.ts';

/** `$id` of the published schema; the version in the name is the contract's `schema`. */
export const NOTIFICATION_MESSAGE_SCHEMA_ID = `https://browserhive.ai/schemas/notification-message.v${NOTIFICATION_SCHEMA_VERSION}.json`;

/**
 * JSON Schema of the notification contract, for consumers of the generic webhook and anyone
 * building a renderer outside BrowserHive.
 *
 * @returns A draft 2020-12 schema object.
 */
export function notificationMessageJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(NotificationMessage, {
    io: 'output',
    target: 'draft-2020-12',
    unrepresentable: 'any',
  });
  const { $schema, ...rest } = schema;
  return {
    $schema,
    $id: NOTIFICATION_MESSAGE_SCHEMA_ID,
    title: 'BrowserHive notification message',
    description: `NotificationMessage, schema ${NOTIFICATION_SCHEMA_VERSION}. Every revision is the complete state; consumers render the whole message and ignore kinds, blocks, inlines and actions they do not know.`,
    ...rest,
  };
}

/** @module app/auth/events — bus event names and payloads published by the auth subsystem (append to `app/events/catalog.ts`). */

import type { AuthEventType } from '../../ports/persistence/enums.ts';
import type { AuthEventRecord } from '../../ports/persistence/records-identity.ts';

/** Payload of every `auth.*` event: the audit row as written (without `seq`). */
export type AuthEventPayload = Omit<AuthEventRecord, 'seq'>;

/** `auth.<auth_events.type>` for each audit type. */
export type AuthEventName = `auth.${AuthEventType}`;

/** Event map contributed to `DomainEvents`. */
export type AuthEvents = { readonly [N in AuthEventName]: AuthEventPayload };

/** Builds the bus event name for an audit type. */
export function authEventName(type: AuthEventType): AuthEventName {
  return `auth.${type}`;
}

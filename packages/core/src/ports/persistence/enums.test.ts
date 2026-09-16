/** @module ports/persistence/enums.test — the DB enum tuples must equal the contracts enums where both exist. */

import { describe, expect, it } from 'bun:test';
import {
  ActorKind,
  AttentionMode,
  BlockedSource,
  Channel,
  ClosedReason,
  CredentialKind,
  DegradationSeverity,
  NotificationType,
  OperatorRequestKind,
  OperatorRequestStatus,
  PersistenceMode,
  PrincipalKind,
  SessionStatus,
  Transport,
  UrlCategory,
} from '@browserhive/contracts/enums';
import {
  ACTOR_KINDS,
  ATTENTION_MODES,
  BLOCK_SOURCES,
  CLOSED_REASONS,
  CREDENTIAL_KINDS,
  MCP_TRANSPORTS,
  NOTIFICATION_TYPES,
  OPERATOR_REQUEST_KINDS,
  OPERATOR_REQUEST_STATUSES,
  PAGE_CATEGORIES,
  PERSISTENCE_MODES,
  PRINCIPAL_KINDS,
  SESSION_CHANNELS,
  SESSION_STATES,
  SYSTEM_EVENT_SEVERITIES,
} from './enums.ts';

describe('persistence enums', () => {
  it('match the contracts enums value for value', () => {
    const pairs: [readonly string[], readonly string[]][] = [
      [ACTOR_KINDS, ActorKind.options],
      [ATTENTION_MODES, AttentionMode.options],
      [BLOCK_SOURCES, BlockedSource.options],
      [SESSION_CHANNELS, Channel.options],
      [CLOSED_REASONS, ClosedReason.options],
      [CREDENTIAL_KINDS, CredentialKind.options],
      [SYSTEM_EVENT_SEVERITIES, DegradationSeverity.options],
      [NOTIFICATION_TYPES, NotificationType.options],
      [OPERATOR_REQUEST_KINDS, OperatorRequestKind.options],
      [OPERATOR_REQUEST_STATUSES, OperatorRequestStatus.options],
      [PERSISTENCE_MODES, PersistenceMode.options],
      [PRINCIPAL_KINDS, PrincipalKind.options],
      [SESSION_STATES, SessionStatus.options],
      [MCP_TRANSPORTS, [...Transport.options].sort()],
      [PAGE_CATEGORIES, UrlCategory.options],
    ];
    for (const [ours, theirs] of pairs) expect([...ours].sort()).toEqual([...theirs].sort());
  });
});

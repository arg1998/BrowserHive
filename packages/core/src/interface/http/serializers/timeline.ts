/** @module interface/http/serializers/timeline — merged timeline items → wire (spec 03 §4.2). */

import type {
  SiteGuardHitRow,
  TimelineItem as WireTimelineItem,
} from '@browserhive/contracts/http';
import type { z } from 'zod';
import { assertNever } from '../../../kernel/errors/app-error.ts';
import type { TimelineItem } from '../../../ports/persistence/analytics.ts';
import type { SiteGuardHitRecord } from '../../../ports/persistence/site-packs.ts';
import { blockedToWire, pageToWire, toolCallToWire, vaultAccessToWire } from './facts.ts';
import { operatorRequestToWire } from './operator-requests.ts';

/** One timeline item; `id` is kind-qualified and unique, `seq` is the tool call ordinal for tool items and 0 otherwise. */
export function timelineItemToWire(item: TimelineItem): z.input<typeof WireTimelineItem> {
  switch (item.kind) {
    case 'tool':
      return {
        kind: 'tool',
        id: item.id,
        ts: item.ts,
        seq: item.item.seq,
        row: toolCallToWire(item.item, false),
      };
    case 'page':
      return { kind: 'page', id: item.id, ts: item.ts, seq: 0, row: pageToWire(item.item) };
    case 'attention':
      return {
        kind: 'attention',
        id: item.id,
        ts: item.ts,
        seq: 0,
        row: operatorRequestToWire(item.item),
      };
    case 'vault':
      return { kind: 'vault', id: item.id, ts: item.ts, seq: 0, row: vaultAccessToWire(item.item) };
    case 'blocked':
      return { kind: 'blocked', id: item.id, ts: item.ts, seq: 0, row: blockedToWire(item.item) };
    case 'guard':
      return {
        kind: 'guard',
        id: item.id,
        ts: item.ts,
        seq: 0,
        row: siteGuardHitToWire(item.item),
      };
    default:
      return assertNever(item);
  }
}

/** One `site_guard_hits` row as the wire row (spec 13 §9.9). */
export function siteGuardHitToWire(record: SiteGuardHitRecord): SiteGuardHitRow {
  return {
    event_id: record.eventId,
    session_id: record.sessionId,
    template_id: record.templateId,
    pack_id: record.packId,
    guard_id: record.guardId,
    guard_kind: record.guardKind,
    action: record.action,
    outcome: record.outcome,
    decided_by: record.decidedBy,
    source: record.source,
    method: record.method,
    url: record.url,
    request_id: record.requestId,
    tool: record.tool,
    ts: record.ts,
  };
}

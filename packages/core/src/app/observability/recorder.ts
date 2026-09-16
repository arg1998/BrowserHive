/** @module app/observability/recorder — the event → DB projection: subscribes to the bus and enqueues typed rows through the WriteQueue; applies D-20 (result policy, 16 KiB cap, URL sanitizing, redaction); never throws. */

import type { RecordToolResults } from '@browserhive/contracts/enums';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Redactor } from '../../kernel/redact.ts';
import { classifyUrl, sanitizeUrl } from '../../kernel/url.ts';
import type { EventBus } from '../../ports/event-bus.ts';
import type { Logger } from '../../ports/logger.ts';
import type { ActorKind } from '../../ports/persistence/enums.ts';
import type {
  BlockedRequestRecord,
  JsonObject,
  NewEvent,
  PageRecord,
  ScreenshotRecord,
  ToolCallRecord,
  VaultAccessRecord,
} from '../../ports/persistence/records.ts';
import type { Repositories } from '../../ports/persistence/unit-of-work.ts';
import type { WriteQueue } from '../../ports/persistence/write-queue.ts';
import {
  type DomainEventName,
  type DomainEvents,
  isRecord,
  type PublishedEvent,
  sessionIdOf,
} from '../events/catalog.ts';
import { applyResultPolicy } from './tool-result-policy.ts';

/** The `ServerConfig` keys the recorder consumes. */
export interface RecorderConfig {
  readonly recordToolResults: RecordToolResults;
  readonly urlQueryAllowlist: readonly string[];
}

/** Dependencies of {@link Recorder}. */
export interface RecorderDeps {
  readonly bus: EventBus<DomainEvents>;
  readonly queue: WriteQueue;
  readonly logger: Logger;
  readonly redactor: Redactor;
  readonly config: RecorderConfig;
}

/** Events that also land in the ordered `events` log (feed replay, audit, export). */
const LOGGED_EVENTS: ReadonlySet<DomainEventName> = new Set<DomainEventName>([
  'session.opened',
  'session.closed',
  'session.warning',
  'tool.called',
  'page.visited',
  'screenshot.captured',
  'blocklist.hit',
  'vault.access',
  'attention.created',
  'attention.resolved',
  'vault.confirm.created',
  'vault.confirm.resolved',
]);

/** Internal-only keys stripped from the compact `events.payload_json`. */
const INTERNAL_KEYS: ReadonlySet<string> = new Set([
  'record',
  'patch',
  'observation',
  'path',
  'type',
]);

/**
 * Subscribed first (synchronously) at composition so every mutation is durable before the WS feed
 * sees it. Each handler enqueues one write; a handler failure is logged and never rethrown; a
 * refused enqueue (queue closed/full) is counted by the queue itself.
 */
export class Recorder {
  private readonly deps: RecorderDeps;
  private readonly log: Logger;
  private unsubscribe: (() => void) | undefined;

  constructor(deps: RecorderDeps) {
    this.deps = deps;
    this.log = deps.logger.child({ module: 'observability.recorder' });
  }

  /** Subscribes to every event. Idempotent; returns the unsubscribe. */
  start(): () => void {
    if (this.unsubscribe === undefined) {
      this.unsubscribe = this.deps.bus.subscribeAll((event) => this.handle(event));
    }
    return () => this.stop();
  }

  /** Unsubscribes. Idempotent. */
  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private handle(event: PublishedEvent): void {
    try {
      this.project(event);
      if (LOGGED_EVENTS.has(event.name)) this.appendLog(event);
    } catch (err) {
      this.log.error('projection failed', { event: event.name, err: serializeError(err) });
    }
  }

  private project(event: PublishedEvent): void {
    switch (event.name) {
      case 'session.opened': {
        const { record } = narrow(event, 'session.opened');
        this.enqueue('sessions.insert', (r) => r.sessions.insert(record));
        return;
      }
      case 'session.updated': {
        const { session, patch } = narrow(event, 'session.updated');
        this.enqueue('sessions.update', async (r) => {
          await r.sessions.update(session.session_id, patch);
        });
        return;
      }
      case 'session.closed': {
        const { session_id, closed_at, reason } = narrow(event, 'session.closed');
        this.enqueue('sessions.markClosed', async (r) => {
          await r.sessions.markClosed(session_id, closed_at, reason);
        });
        return;
      }
      case 'tool.called': {
        const record = this.toolCallRecord(narrow(event, 'tool.called').observation);
        this.enqueue('tool_calls.insert', (r) => r.toolCalls.insert(record));
        return;
      }
      case 'page.visited': {
        const record = this.pageRecord(narrow(event, 'page.visited').row);
        this.enqueue('pages.insert', (r) => r.pages.insert(record));
        return;
      }
      case 'screenshot.captured': {
        const { row, path } = narrow(event, 'screenshot.captured');
        const record: ScreenshotRecord = {
          eventId: row.event_id,
          sessionId: row.session_id,
          path,
          kind: row.kind,
          contentType: row.content_type,
          width: row.width,
          height: row.height,
          sizeBytes: row.size_bytes,
          ts: row.ts,
        };
        this.enqueue('screenshots.insert', (r) => r.screenshots.insert(record));
        return;
      }
      case 'blocklist.hit': {
        const { row } = narrow(event, 'blocklist.hit');
        const record: BlockedRequestRecord = {
          eventId: row.event_id,
          sessionId: row.session_id,
          toolEventId: row.tool_event_id,
          url: this.sanitize(row.url),
          domain: row.domain,
          pattern: row.pattern,
          source: row.source,
          tool: row.tool,
          ts: row.ts,
        };
        this.enqueue('blocked_requests.insert', (r) => r.blocklistAudit.insert(record));
        return;
      }
      case 'vault.access': {
        const { row } = narrow(event, 'vault.access');
        const record: VaultAccessRecord = {
          eventId: row.event_id,
          sessionId: row.session_id,
          toolEventId: row.tool_event_id,
          entryName: row.entry_name,
          handle: row.handle,
          result: row.result,
          reason: row.reason === null ? null : this.deps.redactor.scrubText(row.reason),
          evaluateEnabled: row.evaluate_enabled,
          pageUrl: this.sanitize(row.page_url),
          originCheck: row.origin_check,
          principalId: row.principal_id,
          details: toJsonObject(this.deps.redactor.redactValue(row.details)),
          ts: row.ts,
        };
        this.enqueue('vault_access.insert', (r) => r.vaultAudit.insert(record));
        return;
      }
      default:
        return;
    }
  }

  private toolCallRecord(o: DomainEvents['tool.called']['observation']): ToolCallRecord {
    const args = toJsonObject(this.deps.redactor.redactValue(o.args)) ?? {};
    return {
      eventId: o.eventId,
      sessionId: o.sessionId,
      connectionId: o.connectionId,
      tool: o.tool,
      tabId: o.tabId,
      args,
      ok: o.ok,
      errorCode: o.errorCode,
      errorMessage: o.errorMessage === null ? null : this.deps.redactor.scrubText(o.errorMessage),
      resultText: applyResultPolicy(
        o.resultText,
        this.deps.config.recordToolResults,
        this.deps.redactor,
      ),
      resultSizeBytes: o.resultSizeBytes,
      durationMs: o.durationMs,
      ts: o.ts,
      traceId: o.traceId,
      spanId: o.spanId,
      seq: o.seq,
    };
  }

  private pageRecord(row: DomainEvents['page.visited']['row']): PageRecord {
    const classified = classifyUrl(row.url);
    return {
      eventId: row.event_id,
      sessionId: row.session_id,
      tabId: row.tab_id,
      url: this.sanitize(row.url),
      title: row.title === null ? null : this.deps.redactor.scrubText(row.title),
      domain: classified.domain.length > 0 ? classified.domain : row.domain,
      category: classified.category,
      ts: row.ts,
    };
  }

  private appendLog(event: PublishedEvent): void {
    const sessionId = sessionIdOf(event);
    const payload = compactPayload(event.payload);
    const actor = actorOf(event);
    const record: NewEvent = {
      eventId: eventIdOf(event),
      type: event.name,
      sessionId,
      tenantId: null,
      actorKind: actor.kind,
      actorId: actor.id,
      occurredAt: event.at,
      traceId: actor.traceId,
      payload: toJsonObject(this.deps.redactor.redactValue(payload)) ?? {},
    };
    this.enqueue('events.append', async (r) => {
      await r.events.append(record);
    });
  }

  private sanitize(url: string): string {
    return sanitizeUrl(url, { allowQueryKeys: this.deps.config.urlQueryAllowlist });
  }

  private enqueue(operation: string, job: (repos: Repositories) => Promise<void>): void {
    const accepted = this.deps.queue.enqueue(operation, job);
    if (!accepted) this.log.warn('write refused', { operation });
  }
}

function narrow<N extends DomainEventName>(event: PublishedEvent, name: N): DomainEvents[N] {
  if (event.name !== name) throw new Error(`expected ${name}, got ${event.name}`);
  // The bus stores payloads exactly as published; the name proves the payload type.
  const payload: unknown = event.payload;
  return payload as DomainEvents[N];
}

function toJsonObject(value: unknown): JsonObject | null {
  return isRecord(value) && !Array.isArray(value) ? value : null;
}

function compactPayload(payload: unknown): JsonObject {
  if (!isRecord(payload)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (INTERNAL_KEYS.has(key)) continue;
    out[key] = key === 'row' && isRecord(value) ? withoutResult(value) : value;
  }
  return out;
}

function withoutResult(row: Readonly<Record<string, unknown>>): JsonObject {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === 'result_text' || key === 'args_json') continue;
    out[key] = value;
  }
  return out;
}

function eventIdOf(event: PublishedEvent): string {
  const payload: unknown = event.payload;
  if (isRecord(payload)) {
    const direct = payload['event_id'];
    if (typeof direct === 'string') return direct;
    for (const key of ['row', 'request', 'observation'] as const) {
      const nested = payload[key];
      if (isRecord(nested)) {
        const id = nested['event_id'] ?? nested['eventId'] ?? nested['request_id'];
        if (typeof id === 'string') return id;
      }
    }
    const notification = payload['notification'];
    if (isRecord(notification) && typeof notification['notification_id'] === 'string') {
      return notification['notification_id'];
    }
  }
  return `${event.name}:${event.at}:${sessionIdOf(event) ?? 'system'}`;
}

function actorOf(event: PublishedEvent): {
  kind: ActorKind;
  id: string | null;
  traceId: string | null;
} {
  if (event.name === 'tool.called') {
    const { observation } = narrow(event, 'tool.called');
    return { kind: 'agent', id: observation.principal, traceId: observation.traceId };
  }
  if (event.name === 'page.visited' || event.name === 'screenshot.captured') {
    return { kind: 'agent', id: null, traceId: null };
  }
  if (event.name === 'attention.resolved' || event.name === 'vault.confirm.resolved') {
    const { request } = narrow(event, event.name);
    return {
      kind: request.resolved_by === null ? 'system' : 'operator',
      id: request.resolved_by,
      traceId: null,
    };
  }
  return { kind: 'system', id: null, traceId: null };
}

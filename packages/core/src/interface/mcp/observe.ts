/** @module interface/mcp/observe — builds the one ToolObservation per terminal outcome and publishes `tool.called` then the call's facts (`page.visited`, `screenshot.captured`). Never throws. */

import { PageRow, ScreenshotRow, ToolCallRow } from '@browserhive/contracts/http';
import type { ToolName } from '@browserhive/contracts/tools';
import type { ToolObservation } from '../../app/events/catalog.ts';
import { describeShape } from '../../app/observability/tool-result-policy.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import { redactKeys } from '../../kernel/redact.ts';
import { classifyUrl, sanitizeUrl } from '../../kernel/url.ts';
import type { Logger } from '../../ports/logger.ts';
import type { ToolFacts, ToolTelemetry } from './definition.ts';
import type { ToolServices } from './services.ts';

/** What the dispatcher knows once a call reached a terminal outcome. */
export interface TerminalOutcome {
  readonly eventId: string;
  readonly tool: ToolName;
  readonly sessionId: string | null;
  readonly tabId: string | null;
  readonly connectionId: string | null;
  readonly principal: string;
  readonly rawArgs: unknown;
  readonly ok: boolean;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly resultText: string | null;
  readonly resultSizeBytes: number;
  readonly ts: number;
  readonly durationMs: number;
  readonly traceId: string | null;
  readonly spanId: string | null;
  readonly seq: number;
  readonly telemetry: ToolTelemetry;
  readonly facts: ToolFacts | undefined;
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value));
}

/** Arguments as the observation records them (D-20: key-redacted, or shape only, or nothing). */
export function capturedArgs(
  raw: unknown,
  policy: ToolTelemetry['captureArgs'],
): Record<string, unknown> {
  const record = plainRecord(raw);
  switch (policy) {
    case 'full':
      return plainRecord(redactKeys(record));
    case 'shape':
      return { shape: Object.keys(record).sort() };
    case 'none':
      return {};
  }
}

/** Result text as the observation records it. */
export function capturedResult(
  text: string | null,
  policy: ToolTelemetry['captureResult'],
): string | null {
  if (text === null) return null;
  switch (policy) {
    case 'full':
      return text;
    case 'size':
      return describeShape(text);
    case 'none':
      return null;
  }
}

/** Builds the observation (spec 02 §2.3 shape; `args`/`resultText` per capture policy). */
export function buildObservation(outcome: TerminalOutcome): ToolObservation {
  return {
    eventId: outcome.eventId,
    sessionId: outcome.sessionId,
    connectionId: outcome.connectionId,
    tool: outcome.tool,
    tabId: outcome.tabId,
    args: capturedArgs(outcome.rawArgs, outcome.telemetry.captureArgs),
    ok: outcome.ok,
    errorCode: outcome.errorCode,
    errorMessage: outcome.errorMessage,
    resultText: capturedResult(outcome.resultText, outcome.telemetry.captureResult),
    resultSizeBytes: outcome.resultSizeBytes,
    durationMs: outcome.durationMs,
    ts: outcome.ts,
    principal: outcome.principal,
    traceId: outcome.traceId,
    spanId: outcome.spanId,
    seq: outcome.seq,
  };
}

/**
 * Publishes `tool.called` (and the facts that reference its row). A failing publisher is logged
 * and swallowed: the observer can never alter or replace a tool's result.
 */
export function publishObservation(
  services: ToolServices,
  log: Logger,
  outcome: TerminalOutcome,
): ToolObservation {
  const observation = buildObservation(outcome);
  try {
    const row = ToolCallRow.parse({
      event_id: observation.eventId,
      session_id: observation.sessionId,
      tool: observation.tool,
      tab_id: validTab(observation.tabId),
      ok: observation.ok,
      error_code: observation.errorCode,
      error_message: observation.errorMessage,
      duration_ms: observation.durationMs,
      result_size_bytes: observation.resultSizeBytes,
      ts: observation.ts,
      trace_id: observation.traceId,
      has_screenshot: outcome.facts?.screenshot !== undefined,
    });
    services.bus.publish('tool.called', {
      type: 'tool.called',
      row,
      has_detail: observation.resultText !== null || Object.keys(observation.args).length > 0,
      observation,
    });
    publishFacts(services, outcome);
  } catch (err) {
    log.error('observation failed', { tool: observation.tool, err: serializeError(err) });
  }
  return observation;
}

function validTab(tabId: string | null): string | null {
  return tabId !== null && /^t-[0-9a-z]{6}$/.test(tabId) ? tabId : null;
}

function publishFacts(services: ToolServices, outcome: TerminalOutcome): void {
  const visit = outcome.facts?.pageVisit;
  if (visit !== undefined) {
    const classified = classifyUrl(visit.url);
    services.bus.publish('page.visited', {
      type: 'page.visited',
      row: PageRow.parse({
        event_id: outcome.eventId,
        session_id: visit.sessionId,
        tab_id: visit.tabId,
        url: sanitizeUrl(visit.url),
        title: visit.title,
        domain: classified.domain,
        category: classified.category,
        ts: outcome.ts,
      }),
    });
  }
  const shot = outcome.facts?.screenshot;
  if (shot !== undefined && outcome.ok) {
    services.bus.publish('screenshot.captured', {
      type: 'screenshot.captured',
      row: ScreenshotRow.parse({
        event_id: outcome.eventId,
        session_id: shot.sessionId,
        tool: outcome.tool,
        kind: 'tool',
        content_type: shot.contentType,
        width: shot.width,
        height: shot.height,
        size_bytes: shot.sizeBytes,
        ts: outcome.ts,
        url: sanitizeUrl(shot.url),
      }),
      path: shot.path,
    });
  }
}

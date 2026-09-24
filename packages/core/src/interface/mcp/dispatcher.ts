/** @module interface/mcp/dispatcher — the one pipeline every tool call runs through: resolve → span + request context → parse → policies → execute → map error → classify → shape → redact → observe exactly once (spec 02 §2.3). */

import { ERROR_REGISTRY } from '@browserhive/contracts/errors';
import { UNKNOWN_HARNESS } from '@browserhive/contracts/harness';
import type { ToolName } from '@browserhive/contracts/tools';
import { isSpanContextValid, SpanStatusCode, type Tracer, trace } from '@opentelemetry/api';
import type { z } from 'zod';
import type { RequestPrincipal } from '../../domain/auth/principal.ts';
import type { ProgressReport } from '../../domain/operator-requests/heartbeat.ts';
import type { SessionClientInfo } from '../../domain/session/client-info.ts';
import type { Session } from '../../domain/session/session.ts';
import { type RequestContext, runWithRequestContext } from '../../kernel/context.ts';
import { AppError } from '../../kernel/errors/app-error.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Logger } from '../../ports/logger.ts';
import type { ToolCallContext } from './context.ts';
import type { PolicyContext, ToolFacts, ToolResult } from './definition.ts';
import type { ResolvedIdentity } from './identity.ts';
import { publishObservation, type TerminalOutcome } from './observe.ts';
import type { ToolRegistry } from './registry.ts';
import type { ToolServices } from './services.ts';
import {
  firstText,
  publicMessageOf,
  redactShaped,
  type ShapedResult,
  shapedSize,
  shapeError,
  shapeSuccess,
  toAppError,
} from './shape.ts';
import { classifyToolOutcome } from './tool-outcome.ts';
import { parentContextFromMeta } from './trace-meta.ts';

/** Span name of one tool call (spec 10 §6). */
export const TOOL_SPAN = 'mcp.tool_call';

/** Constructor dependencies of {@link ToolDispatcher}. */
export interface ToolDispatcherDeps {
  readonly services: ToolServices;
  readonly registry: ToolRegistry;
  readonly logger: Logger;
  /** Defaults to `trace.getTracer('browserhive')`. */
  readonly tracer?: Tracer;
}

/** Per-call transport facts the server hands the dispatcher. */
export interface DispatchCall {
  readonly principal: RequestPrincipal;
  readonly connectionId: string | null;
  /** Self-reported client identity; absent or `null` when unknown. */
  readonly client?: SessionClientInfo | null;
  /** The identity resolved for this call (02 §1.4); absent when the server has none (tests, embedders). */
  readonly identity?: ResolvedIdentity;
  /** The request's `_meta` (trace parent, progress token). */
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
  /** Sends `notifications/progress`; absent when the client supplied no progress token. */
  readonly sendProgress?: (report: ProgressReport) => Promise<void>;
}

/** Span attributes of the caller's identity (10 §6); `model` only when one was reported. */
export function identityAttributes(identity: ResolvedIdentity | undefined): Record<string, string> {
  if (identity === undefined) return {};
  return {
    'browserhive.harness': identity.harness,
    'browserhive.harness_source': identity.harnessSource,
    ...(identity.model !== null && { 'browserhive.model': identity.model }),
  };
}

function issuePath(path: readonly PropertyKey[]): string {
  return path.length === 0 ? 'input' : path.map((p) => String(p)).join('.');
}

/** Builds `INVALID_ARGUMENTS` from zod issues; text is `<first issue path>: <message>`. */
export function invalidArguments(error: z.ZodError): AppError<'INVALID_ARGUMENTS'> {
  const issues = error.issues.map((i) => ({ path: issuePath(i.path), message: i.message }));
  const first = issues[0] ?? { path: 'input', message: 'invalid arguments' };
  return new AppError(
    'INVALID_ARGUMENTS',
    { issues },
    { publicMessage: `${first.path}: ${first.message}` },
  );
}

function stringField(value: unknown, key: string): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const field: unknown = Object.getOwnPropertyDescriptor(value, key)?.value;
  return typeof field === 'string' ? field : null;
}

/** The dispatcher. One instance per server; stateless apart from per-session sequence numbers. */
export class ToolDispatcher {
  private readonly deps: ToolDispatcherDeps;
  private readonly tracer: Tracer;
  private readonly log: Logger;
  private readonly seqs = new Map<string, number>();

  constructor(deps: ToolDispatcherDeps) {
    this.deps = deps;
    this.tracer = deps.tracer ?? trace.getTracer('browserhive');
    this.log = deps.logger.child({ module: 'mcp.dispatcher' });
  }

  /** The registry this dispatcher serves. */
  get registry(): ToolRegistry {
    return this.deps.registry;
  }

  /** True when `name` is a registered tool (unknown names are protocol errors, not tool results). */
  has(name: string): name is ToolName {
    return this.deps.registry.get(name) !== undefined;
  }

  /** Runs one call to a terminal, shaped, redacted result. Never throws. */
  dispatch(name: ToolName, rawArgs: unknown, call: DispatchCall): Promise<ShapedResult> {
    const services = this.deps.services;
    const eventId = services.ids.eventId();
    const ts = services.clock.now();
    const parent = parentContextFromMeta(call.meta);
    return this.tracer.startActiveSpan(
      TOOL_SPAN,
      {
        attributes: {
          'browserhive.tool': name,
          'browserhive.event_id': eventId,
          'browserhive.principal': call.principal.subject,
          ...identityAttributes(call.identity),
        },
      },
      parent,
      async (span) => {
        const spanContext = span.spanContext();
        const valid = isSpanContextValid(spanContext);
        const request: RequestContext = {
          traceId: spanContext.traceId,
          spanId: spanContext.spanId,
          requestId: eventId,
          eventId,
          principal: call.principal.subject,
          transport: services.runtime.transport,
        };
        try {
          const outcome = await runWithRequestContext(request, () =>
            this.run(name, rawArgs, call, { eventId, ts, request }),
          );
          span.setAttributes({
            'browserhive.ok': outcome.ok,
            'browserhive.result_bytes': outcome.resultSizeBytes,
            ...(outcome.sessionId !== null && { 'browserhive.session_id': outcome.sessionId }),
            ...(outcome.tabId !== null && { 'browserhive.tab_id': outcome.tabId }),
            ...(outcome.errorCode !== null && { 'browserhive.error_code': outcome.errorCode }),
          });
          if (!outcome.ok) span.setStatus({ code: SpanStatusCode.ERROR });
          publishObservation(services, this.log, {
            ...outcome,
            traceId: valid ? spanContext.traceId : null,
            spanId: valid ? spanContext.spanId : null,
          });
          return outcome.shaped;
        } finally {
          span.end();
        }
      },
    );
  }

  private async run(
    name: ToolName,
    rawArgs: unknown,
    call: DispatchCall,
    ids: { eventId: string; ts: number; request: RequestContext },
  ): Promise<Omit<TerminalOutcome, 'traceId' | 'spanId'> & { shaped: ShapedResult }> {
    const services = this.deps.services;
    const registry = this.deps.registry;
    const definition = registry.get(name);
    const log = this.deps.logger.child({ module: 'mcp.tools', tool: name, eventId: ids.eventId });
    const holder: { session: Session | null } = { session: null };
    let facts: ToolFacts | undefined;
    let shaped: ShapedResult;
    let ok = true;
    let errorCode: string | null = null;
    let errorMessage: string | null = null;
    let resultSessionId: string | null = null;
    const noProgress = async (): Promise<void> => undefined;
    const ctx: PolicyContext = {
      principal: call.principal,
      connectionId: call.connectionId,
      client: call.client ?? null,
      request: ids.request,
      eventId: ids.eventId,
      tool: name,
      reportProgress: call.sendProgress ?? noProgress,
      progressEnabled: call.sendProgress !== undefined,
      signal: call.signal,
      log,
      services,
      get session() {
        return holder.session;
      },
      attachSession(resolved) {
        holder.session = resolved;
      },
    };
    try {
      if (definition === undefined || !registry.isAvailable(name)) {
        const requires = registry.requirementOf(name);
        throw new AppError(
          'TOOL_NOT_AVAILABLE',
          { tool: name, requires },
          {
            publicMessage: `Tool '${name}' is not available on this server (requires ${requires}).`,
          },
        );
      }
      const schema = registry.inputOf(name);
      let args: unknown;
      if (schema !== undefined) {
        const parsed = schema.safeParse(rawArgs ?? {});
        if (!parsed.success) throw invalidArguments(parsed.error);
        args = parsed.data;
      }
      const argRecord =
        typeof args === 'object' && args !== null ? Object.fromEntries(Object.entries(args)) : {};
      for (const policy of definition.policies) await policy.apply(ctx, argRecord);
      const handlerCtx: ToolCallContext = ctx;
      // The registry pairs each name with its own definition; the parsed args came from that
      // definition's schema, so the widened handler receives exactly its contract's input.
      const handler = definition.handler as (
        c: ToolCallContext,
        a: unknown,
      ) => Promise<ToolResult<unknown>>;
      const result = await handler(handlerCtx, args);
      facts = result.facts;
      const value = result.kind === 'json' ? result.value : result.structured;
      // Only ids of sessions that exist are recorded (tool_calls.session_id references sessions).
      const closed =
        typeof value === 'object' &&
        value !== null &&
        Object.getOwnPropertyDescriptor(value, 'closed')?.value === true;
      if (name === 'launch_session' || (name === 'close_session' && closed)) {
        resultSessionId = stringField(value, 'session_id');
      }
      const soft = classifyToolOutcome(name, value);
      if (soft !== null) {
        errorCode = soft.code;
        errorMessage = soft.message;
      }
      shaped = shapeSuccess(result, definition.output);
    } catch (err) {
      ok = false;
      const error = toAppError(err, ids.eventId);
      if (error.code === 'INTERNAL_ERROR') {
        log.error('tool failed', { err: serializeError(err) });
      }
      errorCode = error.code;
      errorMessage =
        error.message === ERROR_REGISTRY[error.code].title ? publicMessageOf(error) : error.message;
      shaped = shapeError(error, services.runtime.transport);
      facts = undefined;
    }
    const resolved = holder.session;
    const sessionId = resolved?.id ?? resultSessionId;
    const scrub = (text: string): string => services.redaction.scrubText(sessionId, text);
    shaped = redactShaped(shaped, scrub);
    if (errorMessage !== null) errorMessage = scrub(errorMessage);
    const tabArg = stringField(rawArgs, 'tab_id');
    const tabId = facts?.pageVisit?.tabId ?? tabArg ?? resolved?.tabs.activeTabId() ?? null;
    // `toolCalls`/`errors` are counted from the published `tool.called` (app/sessions/session-counters).
    const durationMs = Math.max(0, services.clock.now() - ids.ts);
    const harness = call.identity?.harness ?? UNKNOWN_HARNESS;
    log.info('tool called', {
      ok,
      durationMs,
      harness,
      ...(errorCode !== null && { errorCode }),
    });
    return {
      shaped,
      eventId: ids.eventId,
      tool: name,
      sessionId,
      tabId,
      connectionId: call.connectionId,
      principal: call.principal.subject,
      harness,
      rawArgs,
      ok,
      errorCode,
      errorMessage,
      resultText: firstText(shaped),
      resultSizeBytes: shapedSize(shaped),
      ts: ids.ts,
      durationMs,
      seq: sessionId === null ? 0 : this.nextSeq(sessionId),
      telemetry: definition?.telemetry ?? { captureArgs: 'full', captureResult: 'full' },
      facts,
    };
  }

  private nextSeq(sessionId: string): number {
    const next = (this.seqs.get(sessionId) ?? 0) + 1;
    this.seqs.set(sessionId, next);
    return next;
  }
}

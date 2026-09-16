/** @module interface/mcp/context — ToolCallContext (spec 02 §2.2), RuntimeFacts and the ToolServices record the composition root builds. */

import type { RequestPrincipal } from '../../domain/auth/principal.ts';
import type { ProgressReport } from '../../domain/operator-requests/heartbeat.ts';
import type { Session } from '../../domain/session/session.ts';
import type { RequestContext } from '../../kernel/context.ts';
import { AppError } from '../../kernel/errors/app-error.ts';
import type { Logger } from '../../ports/logger.ts';
import type { ToolServices } from './services.ts';

export type { RuntimeFacts } from './runtime.ts';

/** Per-call context handed to every tool handler. */
export interface ToolCallContext {
  readonly principal: RequestPrincipal;
  /** MCP session's connection record, or `null` (stdio, in-memory). */
  readonly connectionId: string | null;
  readonly request: RequestContext;
  /** `e-<ulid>`, minted before the handler; used by screenshot archival. */
  readonly eventId: string;
  readonly tool: string;
  /** Forwards `notifications/progress`; a no-op when the client sent no progress token. */
  readonly reportProgress: (report: ProgressReport) => Promise<void>;
  /** Whether the client supplied a progress token (heartbeats only make sense when it did). */
  readonly progressEnabled: boolean;
  /** Aborted on `notifications/cancelled` or transport close. */
  readonly signal: AbortSignal;
  /** Child logger bound to tool/session/event ids. */
  readonly log: Logger;
  readonly services: ToolServices;
  /** The session resolved by the ownership policy, or `null` for tools that name none. */
  readonly session: Session | null;
}

/** The session the ownership policy resolved. @throws `INTERNAL_ERROR` when the policy did not run. */
export function requireSession(ctx: ToolCallContext): Session {
  if (ctx.session === null) {
    throw new AppError(
      'INTERNAL_ERROR',
      { ref: ctx.request.requestId ?? ctx.eventId },
      { message: `tool '${ctx.tool}' reached its handler without the session ownership policy` },
    );
  }
  return ctx.session;
}

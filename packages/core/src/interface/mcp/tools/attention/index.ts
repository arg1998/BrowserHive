/** @module interface/mcp/tools/attention — request_attention (blocking, heartbeats) and get_attention_result (http only). */

import { requestAttentionDescription } from '@browserhive/contracts/tools';
import type { AttentionCallContext } from '../../../../app/attention/attention-service.ts';
import { safeCurrentUrl } from '../../../../app/sessions/metadata.ts';
import { AppError } from '../../../../kernel/errors/app-error.ts';
import { requireSession, type ToolCallContext } from '../../context.ts';
import { defineTool, json, type ToolPack } from '../../definition.ts';
import { sessionOwnership, transportHttp } from '../../policies.ts';
import type { AttentionLike } from '../../services.ts';

function attentionOf(ctx: ToolCallContext): AttentionLike {
  const attention = ctx.services.attention;
  if (attention !== null) return attention;
  // No broker exists without the http transport; the `transportHttp` policy normally refused already.
  throw new AppError(
    'ATTENTION_REQUIRES_HTTP',
    { tool: ctx.tool },
    {
      publicMessage: `'${ctx.tool}' requires the http transport; human-in-the-loop attention is not available under stdio.`,
    },
  );
}

function callContext(
  ctx: ToolCallContext,
  extra: Partial<AttentionCallContext>,
): AttentionCallContext {
  return {
    principal: ctx.principal.subject,
    toolEventId: ctx.eventId,
    signal: ctx.signal,
    // Heartbeats only when the client can receive progress; otherwise a plain await.
    ...(ctx.progressEnabled && { reportProgress: ctx.reportProgress }),
    ...extra,
  };
}

/** `request_attention`: blocks until resolved/rejected/timeout/cancelled; the floor is in the description. */
export const requestAttention = defineTool('request_attention', {
  description: (runtime) =>
    requestAttentionDescription(Math.floor(runtime.minAttentionWaitMs / 1000)),
  requires: { transport: 'http' },
  policies: [transportHttp, sessionOwnership],
  async handler(ctx, args) {
    const session = requireSession(ctx);
    const outcome = await attentionOf(ctx).request(
      session.id,
      {
        reason: args.reason,
        mode: args.mode,
        ...(args.options !== undefined && { options: args.options }),
        ...(args.max_wait_seconds !== undefined && { maxWaitSeconds: args.max_wait_seconds }),
      },
      callContext(ctx, { sessionSlug: session.slug, pageUrl: safeCurrentUrl(session) }),
    );
    return json(outcome);
  },
});

/** `get_attention_result`: settled ⇒ immediate; pending ⇒ blocks; unknown or foreign ⇒ `rejected`. */
export const getAttentionResult = defineTool('get_attention_result', {
  requires: { transport: 'http' },
  policies: [transportHttp],
  async handler(ctx, args) {
    return json(await attentionOf(ctx).result(args.request_id, callContext(ctx, {})));
  },
});

/** The attention pack. */
export const attentionPack: ToolPack = {
  id: 'attention',
  requires: { transport: 'http' },
  tools: [requestAttention, getAttentionResult],
};

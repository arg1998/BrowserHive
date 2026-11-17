/** @module app/site-packs/security-intercepts-writes — opening a write confirmation (spec 13 §9.3): the `security_intercept` row with `reason: 'write_confirm'`, the session's hold and `SITE_WRITE_HELD` warning, the `site_pack.confirm` events of the coalesced notification, and the broker outcome as the guard's answer. */

import type { SecurityInterceptOptions } from '@browserhive/contracts/http';
import type { OperatorRequestOutcome } from '../../domain/operator-requests/types.ts';
import { sessionWarning } from '../../domain/session/warnings.ts';
import { assertNever } from '../../kernel/errors/app-error.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import { registrableDomain } from '../../kernel/url.ts';
import type { RequestConfirmOutcome, RequestConfirmResult } from '../../ports/request-guard.ts';
import type { GuardRuleInfo } from '../../ports/site-guards.ts';
import type { OpenIntercept } from './security-intercepts-state.ts';
import { type InterceptContext, interceptTimeoutMs } from './security-intercepts-types.ts';

/** What a write confirmation is about. */
export interface WriteFacts {
  readonly sessionId: string;
  readonly templateId: string;
  readonly owner: string;
  readonly slug: string;
  readonly site: string;
  readonly guard: GuardRuleInfo;
  readonly method: string | null;
  /** Sanitized (D-20). */
  readonly url: string;
  readonly resourceType: string | null;
  readonly tool: string | null;
  readonly source: 'request' | 'element';
}

/** An opened write confirmation; `promise` settles after the hold is released. */
export interface OpenedWrite {
  readonly id: string;
  readonly promise: Promise<OperatorRequestOutcome>;
}

/** Refused as a `block` (no confirmation was opened). */
export const NOT_CONFIRMABLE: RequestConfirmResult = Object.freeze({
  outcome: 'cancelled',
  decidedBy: null,
  requestId: null,
  asBlock: true,
});

/** Opens a write confirmation and holds the session on it; `null` when the broker refused. */
export async function openWriteConfirmation(
  ctx: InterceptContext,
  facts: WriteFacts,
  signal: AbortSignal | undefined,
): Promise<OpenedWrite | null> {
  const { deps, book } = ctx;
  const options: SecurityInterceptOptions = {
    reason: 'write_confirm',
    site: facts.site,
    site_title: facts.guard.siteTitle,
    pack_id: facts.guard.packId,
    template_id: facts.templateId,
    guard: { id: facts.guard.guardId, kind: facts.guard.guardKind },
    ...(facts.method !== null && { method: facts.method }),
    url: facts.url,
    ...(facts.resourceType !== null && { resource_type: facts.resourceType }),
    ...(facts.tool !== null && { tool: facts.tool }),
    source: facts.source,
  };
  const method = facts.method === null ? '' : `${facts.method} `;
  let handle: Awaited<ReturnType<typeof deps.broker.open>>;
  try {
    handle = await deps.broker.open({
      kind: 'security_intercept',
      sessionId: facts.sessionId,
      sessionSlug: facts.slug,
      owner: facts.owner,
      reason: `${facts.guard.siteTitle} write approval: ${method}${facts.url}`,
      pageUrl: facts.url,
      ...(facts.tool !== null && { tool: facts.tool }),
      options,
      templateId: facts.templateId,
      timeoutMs: interceptTimeoutMs(deps.config),
      ...(signal !== undefined && { signal }),
    });
  } catch (error) {
    // The broker's own queue bounds (RATE_LIMITED): nobody can be asked, so it is refused.
    ctx.log.warn('write confirm not opened', { err: serializeError(error) });
    return null;
  }
  const intercept: OpenIntercept = {
    requestId: handle.id,
    sessionId: facts.sessionId,
    templateId: facts.templateId,
    site: facts.site,
    siteTitle: facts.guard.siteTitle,
    reason: 'write_confirm',
    createdAt: handle.createdAt,
    guard: { packId: facts.guard.packId, id: facts.guard.guardId, kind: facts.guard.guardKind },
    method: facts.method,
    url: facts.url,
    tool: facts.tool,
  };
  book.add(intercept);
  warnHeld(ctx, facts, handle.id);
  void publishConfirm(ctx, 'opened', intercept, undefined);
  const promise = handle.promise.then((outcome) => {
    book.remove(handle.id);
    void publishConfirm(ctx, 'settled', intercept, outcome.status);
    return outcome;
  });
  return { id: handle.id, promise };
}

/** `SITE_WRITE_HELD` on the held session. */
function warnHeld(ctx: InterceptContext, facts: WriteFacts, requestId: string): void {
  const session = ctx.deps.sessions.peek(facts.sessionId);
  if (session === undefined) return;
  const method = facts.method === null ? '' : `${facts.method} `;
  ctx.deps.sessions.warn(
    session,
    sessionWarning(
      'SITE_WRITE_HELD',
      facts.sessionId,
      `${method}${facts.url} on ${facts.site} waits for the operator's approval (request ${requestId}).`,
      {
        request_id: requestId,
        site: facts.site,
        pack_id: facts.guard.packId,
        guard_id: facts.guard.guardId,
        guard_kind: facts.guard.guardKind,
        method: facts.method,
        url: facts.url,
      },
    ),
  );
}

/** `site_pack.confirm`: the coalesced `site_pack.write_confirm` notification follows it. */
async function publishConfirm(
  ctx: InterceptContext,
  phase: 'opened' | 'settled',
  intercept: OpenIntercept,
  status: OperatorRequestOutcome['status'] | undefined,
): Promise<void> {
  const { deps, book } = ctx;
  try {
    const guard = intercept.guard;
    if (guard === undefined) return;
    // Counted before the template read, so the number is the one this phase left.
    const open = book.writesOf(intercept.templateId, intercept.site).length;
    const template = await deps.templates.get(intercept.templateId);
    deps.bus.publish('site_pack.confirm', {
      type: 'site_pack.confirm',
      phase,
      template_id: intercept.templateId,
      template_name: template?.displayName ?? intercept.templateId,
      site: intercept.site,
      site_title: intercept.siteTitle,
      open,
      request_id: intercept.requestId,
      session_id: intercept.sessionId,
      guard: { pack_id: guard.packId, id: guard.id, kind: guard.kind },
      method: intercept.method ?? null,
      url: intercept.url ?? '',
      tool: intercept.tool ?? null,
      ...(status !== undefined && { status }),
      at: deps.clock.now(),
    });
  } catch (error) {
    ctx.log.warn('confirm event not sent', { err: serializeError(error) });
  }
}

/** A broker outcome as the guard's answer. A rejection nobody made (the session closed) is `cancelled`. */
export function toConfirmResult(outcome: OperatorRequestOutcome): RequestConfirmResult {
  const status: RequestConfirmOutcome = (() => {
    switch (outcome.status) {
      case 'resolved':
        return 'approved';
      case 'rejected':
        return outcome.resolvedBy === null ? 'cancelled' : 'denied';
      case 'timeout':
        return 'timeout';
      case 'cancelled':
        return 'cancelled';
      default:
        return assertNever(outcome.status, 'operator request status');
    }
  })();
  return {
    outcome: status,
    decidedBy: status === 'approved' || status === 'denied' ? outcome.resolvedBy : null,
    requestId: outcome.requestId,
  };
}

/** The registrable domain of a URL's host, else the host. */
export function siteOf(url: string): string {
  try {
    const host = new URL(url).hostname;
    const domain = registrableDomain(host);
    return domain.length > 0 ? domain : host;
  } catch {
    return '';
  }
}

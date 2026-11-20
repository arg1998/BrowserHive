/** @module app/site-packs/security-intercepts — `security_intercept` operator requests over the one broker (spec 13 §9.3, §9.5, D-15): the network guard's confirmer that holds a write until the operator decides, the tool path's write approvals, site checks with their health effect, the bounds, the one-time passes and the tool hold every template session obeys. */

import type { Logger } from '../../ports/logger.ts';
import type {
  RequestConfirmation,
  RequestConfirmer,
  RequestConfirmResult,
} from '../../ports/request-guard.ts';
import type {
  ChallengeInput,
  SecurityIntercepts,
  SiteHold,
  WriteApprovalInput,
  WriteApprovalResult,
} from '../../ports/security-intercepts.ts';
import type { GuardRuleInfo } from '../../ports/site-guards.ts';
import { markChallenged, openSiteCheck } from './security-intercepts-checks.ts';
import { PassBook, type ToolPassKey } from './security-intercepts-passes.ts';
import { InterceptBook } from './security-intercepts-state.ts';
import type { InterceptContext, SecurityInterceptsDeps } from './security-intercepts-types.ts';
import {
  NOT_CONFIRMABLE,
  openWriteConfirmation,
  siteOf,
  toConfirmResult,
  type WriteFacts,
} from './security-intercepts-writes.ts';

export type {
  SecurityInterceptsConfig,
  SecurityInterceptsDeps,
} from './security-intercepts-types.ts';
export { toConfirmResult } from './security-intercepts-writes.ts';

/**
 * The `SecurityIntercepts` port over `OperatorRequestBroker`. Every intercept is a
 * `security_intercept` row owned by the session's principal (so `get_attention_result` answers it),
 * with `deadline_at = now + max(attentionTimeout, minAttentionWait)`. While one is open its session
 * is held: `holdOf` names it and the dispatcher answers `SITE_OPERATOR_PENDING`.
 *
 * Network path (`confirmer`): a host-owned request, a non-template session or a template at its
 * bound of ten open intercepts is refused as a `block`; a second write of a session whose write is
 * held is aborted (`cancelled`, the hit names the held request); otherwise the write is held until
 * the operator approves (`approved`), denies (`denied`), the deadline passes (`timeout`), the
 * request goes away or the session closes (`cancelled`).
 *
 * Passes: an approval on the tool path grants a one-time pass for (session, guard, URL) for 10
 * minutes; using it grants the network guard one pass for the element guard's `request_guard`
 * (60 s), so the approved click's write is not asked again. The network path itself grants no
 * pass: the approved request goes out, and an identical later write is a new write.
 *
 * Under `transport=stdio` nothing is opened: `confirmer` is `null` (a `confirm` acts as `block`),
 * write approvals answer `blocked: no_operator` and site checks only mark health.
 */
export class SecurityInterceptService implements SecurityIntercepts {
  readonly confirmer: RequestConfirmer | null;
  readonly #ctx: InterceptContext;
  readonly #off: () => void;

  constructor(deps: SecurityInterceptsDeps) {
    const log: Logger = deps.logger.child({ module: 'site-packs.intercepts' });
    this.#ctx = { deps, book: new InterceptBook(), passes: new PassBook(), log };
    this.confirmer =
      deps.config.transport === 'stdio' ? null : { confirm: (request) => this.#confirm(request) };
    this.#off = deps.bus.subscribe('session.closed', ({ payload }) =>
      this.#sessionClosed(payload.session_id),
    );
  }

  /** Unsubscribes from the bus. */
  stop(): void {
    this.#off();
  }

  holdOf(sessionId: string): SiteHold | null {
    return this.#ctx.book.holdOf(sessionId);
  }

  async requestWriteApproval(input: WriteApprovalInput): Promise<WriteApprovalResult> {
    if (this.confirmer === null) return { kind: 'blocked', reason: 'no_operator' };
    const { deps, book, passes } = this.#ctx;
    const now = deps.clock.now();
    const guard = `${input.packId}#${input.guardId}`;
    const key = toolPassKey(input, guard);
    const pass = passes.takeTool(key, now);
    if (pass !== null) {
      // The approved action now runs; the write it sends (to the same site) needs no second
      // approval.
      const ruleGuard =
        input.source === 'element'
          ? (deps.requestGuardOf?.(input.packId, input.guardId) ?? null)
          : input.guardId;
      if (ruleGuard !== null) {
        passes.grantNetwork(input.sessionId, `${input.packId}#${ruleGuard}`, input.site, pass, now);
      }
      return { kind: 'pass' };
    }
    // From here to the reservation in `openWriteConfirmation` nothing awaits (M3).
    const open = book.writeOf(input.sessionId);
    if (open !== undefined) {
      const id = open.requestId ?? (await open.ready);
      return id === null
        ? { kind: 'blocked', reason: 'bounds' }
        : { kind: 'pending', requestId: id };
    }
    const session = deps.sessions.peek(input.sessionId);
    if (session === undefined) return { kind: 'blocked', reason: 'no_operator' };
    if (book.atBound(input.templateId, session.owner, input.sessionId)) {
      return { kind: 'blocked', reason: 'bounds' };
    }
    const facts: WriteFacts = {
      sessionId: input.sessionId,
      templateId: input.templateId,
      owner: session.owner,
      slug: session.slug,
      site: input.site,
      guard: this.#guardInfo(guard, input.guardKind, input.site, input),
      method: input.method,
      url: input.url,
      resourceType: null,
      tool: input.tool,
      source: input.source,
    };
    const opened = await openWriteConfirmation(this.#ctx, facts, undefined);
    if (opened === null) return { kind: 'blocked', reason: 'bounds' };
    void opened.promise.then((outcome) => this.#toolSettled(facts, key, opened.id, outcome));
    return { kind: 'pending', requestId: opened.id };
  }

  async raiseChallenge(input: ChallengeInput): Promise<string | null> {
    // Under stdio no operator can answer: health only, and the notification only watches.
    await markChallenged(this.#ctx, input, this.confirmer !== null);
    if (this.confirmer === null) return null;
    return openSiteCheck(this.#ctx, input);
  }

  // --- internals ----------------------------------------------------------------------------

  async #confirm(request: RequestConfirmation): Promise<RequestConfirmResult> {
    // A host-owned request has no session to hold: refused as a block (D-67).
    if (request.owner.kind === 'host') return NOT_CONFIRMABLE;
    const { deps, book } = this.#ctx;
    const sessionId = request.owner.sessionId;
    const session = deps.sessions.peek(sessionId);
    const template = session?.template;
    if (session === undefined || template == null) return NOT_CONFIRMABLE;
    // A maintenance session (a probe, a re-login window) is BrowserHive's own: nobody waits on it,
    // so its request is refused like a host-owned one (review I4).
    if (template.mode === 'maintenance') return NOT_CONFIRMABLE;
    const { passes } = this.#ctx;
    const now = deps.clock.now();
    const site = siteOf(request.url);
    const pass = passes.takeNetwork(sessionId, request.ruleId, site, now);
    if (pass !== null) {
      return { outcome: 'approved', decidedBy: pass.decidedBy, requestId: pass.requestId };
    }
    // One open write confirmation per session: a further write is aborted (spec 13 §9.3). From
    // here to the reservation in `openWriteConfirmation` nothing awaits (M3).
    const open = book.writeOf(sessionId);
    if (open !== undefined) {
      const id = open.requestId ?? (await open.ready);
      return { outcome: 'cancelled', decidedBy: null, requestId: id };
    }
    if (book.atBound(template.templateId, session.owner, sessionId)) return NOT_CONFIRMABLE;
    const facts: WriteFacts = {
      sessionId,
      templateId: template.templateId,
      owner: session.owner,
      slug: session.slug,
      site,
      guard: this.#guardInfo(request.ruleId, 'write', site, null),
      method: request.method,
      url: request.url,
      resourceType: request.resourceType,
      tool: null,
      source: 'request',
    };
    const opened = await openWriteConfirmation(this.#ctx, facts, request.signal);
    if (opened === null) return NOT_CONFIRMABLE;
    return toConfirmResult(await opened.promise);
  }

  /** A tool-path write confirmation settled: an approval grants the pass; the decision is audited. */
  #toolSettled(
    facts: WriteFacts,
    key: ToolPassKey,
    requestId: string,
    outcome: Parameters<typeof toConfirmResult>[0],
  ): void {
    const { deps, passes } = this.#ctx;
    const result = toConfirmResult(outcome);
    const now = deps.clock.now();
    if (result.outcome === 'approved') {
      passes.grantTool(key, { requestId, decidedBy: result.decidedBy }, now);
    }
    deps.hits.write({
      sessionId: facts.sessionId,
      templateId: facts.templateId,
      packId: facts.guard.packId,
      guardId: facts.guard.guardId,
      guardKind: facts.guard.guardKind,
      action: 'confirm',
      outcome: result.outcome,
      decidedBy: result.decidedBy,
      source: facts.source === 'element' ? 'element' : 'tool',
      method: facts.method,
      url: facts.url,
      requestId,
      tool: facts.tool,
      ts: now,
    });
  }

  /**
   * What a guard is: the catalog's entry for a network rule id; the tool path's own facts (its
   * guard may be an element guard, which the catalog does not hold) with the pack's title.
   */
  #guardInfo(
    ruleId: string,
    kind: GuardRuleInfo['guardKind'],
    site: string,
    known: Pick<WriteApprovalInput, 'packId' | 'guardId'> | null,
  ): GuardRuleInfo {
    const described = this.#ctx.deps.describe(ruleId);
    if (known !== null) {
      return {
        ruleId,
        packId: known.packId,
        guardId: known.guardId,
        guardKind: kind,
        siteTitle: this.#ctx.deps.packTitle?.(known.packId) ?? described?.siteTitle ?? site,
      };
    }
    if (described !== null) return described;
    const at = ruleId.lastIndexOf('#');
    return {
      ruleId,
      packId: at < 0 ? 'browserhive' : ruleId.slice(0, at),
      guardId: at < 0 ? ruleId : ruleId.slice(at + 1),
      guardKind: kind,
      siteTitle: site,
    };
  }

  /** The session's passes go; its open intercepts are cancelled (the broker settles them too). */
  #sessionClosed(sessionId: string): void {
    const { deps, book, passes } = this.#ctx;
    const open = [book.writeOf(sessionId), book.challengeOf(sessionId)];
    book.forgetSession(sessionId);
    passes.forgetSession(sessionId);
    for (const intercept of open) {
      if (intercept === undefined) continue;
      void intercept.ready
        .then((id) => (id === null ? false : deps.broker.cancel(id)))
        .catch(() => undefined);
    }
  }
}

/** What a tool-path pass covers: the same guard, page, tool and control (review L6). */
function toolPassKey(input: WriteApprovalInput, guard: string): ToolPassKey {
  return {
    sessionId: input.sessionId,
    guard,
    url: input.url,
    tool: input.tool,
    target: input.target ?? null,
  };
}

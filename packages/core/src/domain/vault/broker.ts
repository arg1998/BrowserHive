/** @module domain/vault/broker — the atomic `vault_fill` orchestrator: fixed gate order, one audit row per fill, confirm via the operator-request broker, trace-chunk exclusion, redaction windows. */

import { AppError, isAppError } from '../../kernel/errors/app-error.ts';
import type { Clock } from '../../ports/clock.ts';
import type { EventPublisher } from '../../ports/event-bus.ts';
import type { IdGenerator } from '../../ports/id-generator.ts';
import type { Logger } from '../../ports/logger.ts';
import type { OriginCheck, VaultAccessResult } from '../../ports/persistence/enums.ts';
import type { JsonObject } from '../../ports/persistence/json.ts';
import type { VaultAccessRecord } from '../../ports/persistence/records.ts';
import type { VaultAuditRepository } from '../../ports/persistence/vault-audit.ts';
import type {
  VaultBindingRepository,
  VaultGroupPolicyRepository,
} from '../../ports/persistence/vault-policy.ts';
import type { VaultBackend } from '../../ports/vault-backend.ts';
import type { VaultTyper } from '../../ports/vault-typer.ts';
import type { OpenOperatorRequest, OperatorRequestHandle } from '../operator-requests/types.ts';
import type { CallerSubject } from './bindings.ts';
import { decideFill, evaluateEnabledFor } from './decide-fill.ts';
import { publishVaultAccess } from './events.ts';
import { listAvailable } from './list.ts';
import { clearInputs, formActionAllowed, safeUrl } from './page-actions.ts';
import { PolicySet } from './policies.ts';
import type { VaultRedaction } from './redaction.ts';
import { resolveEntry } from './resolve.ts';
import type {
  ListAvailableOptions,
  ListAvailableResult,
  ResolvedEntry,
  VaultEvents,
  VaultFillContext,
  VaultFillRequest,
  VaultFillResult,
} from './types.ts';

/** Per-field ceiling for credential entry (30 s). */
export const FIELD_ENTRY_TIMEOUT_MS = 30_000;
/** Default confirm deadline: `0` waits indefinitely (the operator decides when to answer). */
export const DEFAULT_CONFIRM_TIMEOUT_MS = 0;

/** The narrow slice of the operator-request broker a fill needs (structural; the real broker satisfies it). */
export interface VaultConfirmGate {
  open(input: OpenOperatorRequest): Promise<OperatorRequestHandle>;
}

/** Constructor dependencies of {@link VaultBroker}. */
export interface VaultBrokerDeps {
  readonly backend: VaultBackend;
  readonly bindings: VaultBindingRepository;
  readonly policies: VaultGroupPolicyRepository;
  readonly audit: VaultAuditRepository;
  readonly redaction: VaultRedaction;
  readonly events: EventPublisher<VaultEvents>;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  /** Whether `evaluate` is globally allowed — combined with the per-session flag. */
  readonly allowEvaluate: boolean;
  /** Absent under stdio → a `dashboard_confirm` entry auto-denies (`no_dashboard`). */
  readonly confirm?: VaultConfirmGate;
  /** Human-cadence typer, used only on sessions with `humanize` on. Absent → instant `fill`. */
  readonly typer?: VaultTyper;
  /** Confirm deadline in ms; `0`/absent waits indefinitely. */
  readonly confirmTimeoutMs?: number;
}

interface Credential {
  readonly username: string;
  readonly password: string;
}

interface ConfirmDecision {
  readonly approved: boolean;
  readonly reason: 'dashboard_denied' | 'confirm_timeout';
  readonly detail: string;
}

/**
 * `fill` is one atomic operation in this exact order; every branch writes exactly one
 * `vault_access` row and every fill-specific outcome is *returned*, never thrown:
 *
 * 1. `vault_enabled` gate → 2. handle + caller authorization → 3. `require_no_evaluate` →
 * 4. origin re-check → 5. dashboard confirm (D-15 broker) → 6. fetch credential →
 * 7. arm redaction BEFORE typing → 8. form-action defence, pause the trace chunk (D-13), type →
 * 9. optional submit (re-check action) → wait → optional clear → resume the chunk (finally) →
 * 10. `{ status: 'success', redacted: true }`.
 *
 * Throws only `VAULT_NOT_CONFIGURED` and `VAULT_LOCKED` (states unrelated to *this* fill; the
 * locked case still writes its audit row). The credential lives in a local for the duration of
 * the typing and in the redaction window — never in a result, log, event row or trace.
 */
export class VaultBroker {
  private readonly deps: VaultBrokerDeps;
  private readonly log: Logger;

  constructor(deps: VaultBrokerDeps) {
    this.deps = deps;
    this.log = deps.logger.child({ module: 'vault.broker' });
  }

  /** `vault_list_available`. Never throws for a locked backend. */
  listAvailable(
    caller: CallerSubject,
    opts: ListAvailableOptions = {},
    signal?: AbortSignal,
  ): Promise<ListAvailableResult> {
    return listAvailable({ ...this.deps, logger: this.log }, caller, opts, signal);
  }

  /** Runs the atomic fill (see the class doc). */
  async fill(request: VaultFillRequest, ctx: VaultFillContext): Promise<VaultFillResult> {
    if (this.deps.backend.kind === 'off') throw new AppError('VAULT_NOT_CONFIGURED', {});
    const { session, page } = ctx;
    const pageUrl = safeUrl(page);
    const evaluateEnabled = evaluateEnabledFor(session, this.deps.allowEvaluate);
    let entryLabel = request.entryName;
    let handle: string | null = null;

    const audit = async (
      result: VaultAccessResult,
      originCheck: OriginCheck,
      details: JsonObject,
    ): Promise<void> => {
      const record: VaultAccessRecord = {
        eventId: this.deps.ids.eventId(),
        sessionId: session.sessionId,
        toolEventId: ctx.toolEventId ?? null,
        entryName: entryLabel,
        handle,
        result,
        reason: typeof details['reason'] === 'string' ? details['reason'] : null,
        evaluateEnabled,
        pageUrl,
        originCheck,
        principalId: ctx.principal,
        details: {
          username_selector: request.usernameSelector,
          password_selector: request.passwordSelector,
          submit_selector: request.submitSelector ?? null,
          ...details,
        },
        ts: this.deps.clock.now(),
      };
      await this.deps.audit.insert(record);
      publishVaultAccess(this.deps.events, record, session.slug);
      this.log.info('vault access', {
        vault: true,
        session_id: session.sessionId,
        entry_name: entryLabel,
        result,
        origin_check: originCheck,
        evaluate_enabled: evaluateEnabled,
      });
    };

    // 2. Resolve the handle (the allow-all path may find the backend locked).
    const policies = new PolicySet(await this.deps.policies.list());
    let entry: ResolvedEntry | undefined;
    try {
      entry = session.vaultEnabled
        ? await resolveEntry(
            {
              bindings: this.deps.bindings,
              backend: this.deps.backend,
              now: () => this.deps.clock.now(),
            },
            policies,
            request.entryName,
            ctx.signal,
          )
        : undefined;
    } catch (err) {
      if (isAppError(err, 'VAULT_LOCKED')) {
        await audit('blocked', 'skipped', { reason: 'vault_locked' });
        throw err;
      }
      entry = undefined;
    }
    if (entry !== undefined) {
      entryLabel = entry.itemName;
      handle = entry.handle;
    }

    // 1–5. Pure gates.
    const decision = decideFill({
      session,
      principal: ctx.principal,
      allowEvaluate: this.deps.allowEvaluate,
      pageUrl,
      entry,
    });
    if (decision.kind === 'blocked') {
      if (decision.reason === 'not_authorized' || decision.reason === 'vault_disabled') {
        entryLabel = request.entryName;
        handle = null;
      }
      await audit('blocked', 'skipped', { reason: decision.reason });
      return blocked(decision.reason);
    }
    if (decision.kind === 'origin_mismatch') {
      await audit('origin_mismatch', 'fail', {
        reason: 'origin_mismatch',
        registrable_domain: decision.origin.registrableDomain,
        detail: decision.origin.reason ?? null,
      });
      return { status: 'origin_mismatch', redacted: true, reason: 'origin_mismatch' };
    }
    const resolved = decision.entry;

    // 5. Dashboard confirmation before the credential is fetched.
    if (decision.confirmRequired) {
      const verdict = await this.runConfirm(ctx, resolved, pageUrl);
      if (!verdict.approved) {
        await audit('denied', 'pass', { reason: verdict.reason, confirm: verdict.detail });
        return blocked(verdict.reason);
      }
    }

    // 6. Fetch the credential. A locked backend is unrelated to this fill → audit + throw.
    let credential: Credential;
    try {
      const item = await this.deps.backend.getEntry(
        { ...(resolved.itemId.length > 0 && { id: resolved.itemId }), name: resolved.itemName },
        ctx.signal,
      );
      credential = { username: item.username, password: item.password.reveal() };
    } catch (err) {
      if (isAppError(err, 'VAULT_LOCKED')) {
        await audit('blocked', 'pass', { reason: 'vault_locked' });
        throw err;
      }
      const reason = isAppError(err, 'VAULT_ENTRY_NOT_FOUND') ? 'entry_not_found' : 'backend_error';
      await audit('auth_failed', 'pass', { reason });
      return { status: 'auth_failed', redacted: true, reason };
    }

    // 7. Arm the redaction window BEFORE any secret can echo back.
    const secrets = [credential.password];
    if (resolved.redactUsername && credential.username.length > 0)
      secrets.push(credential.username);
    const rearm = (): void => this.deps.redaction.arm(session.sessionId, secrets, resolved.origins);
    rearm();

    // 8. Form-action defence (pre-fill), then type with the trace chunk paused (D-13).
    if (!(await formActionAllowed(page, request.passwordSelector, resolved.origins))) {
      await audit('blocked', 'pass', { reason: 'form_action_mismatch', phase: 'pre_fill' });
      return blocked('form_action_mismatch');
    }
    await this.pauseTrace(ctx);
    try {
      try {
        if (credential.username.length > 0) {
          await this.enterValue(ctx, request.usernameSelector, credential.username, rearm);
        }
        await this.enterValue(ctx, request.passwordSelector, credential.password, rearm);
      } catch (err) {
        await audit('auth_failed', 'pass', {
          reason: 'fill_failed',
          detail: this.detail(ctx, err),
        });
        return { status: 'auth_failed', redacted: true, reason: 'fill_failed' };
      }

      // 9. Optional submit — re-validate the action first, click, wait, best-effort clear.
      if (request.submitSelector !== undefined) {
        if (!(await formActionAllowed(page, request.passwordSelector, resolved.origins))) {
          await audit('blocked', 'pass', { reason: 'form_action_mismatch', phase: 'pre_submit' });
          return blocked('form_action_mismatch');
        }
        try {
          await page.click(request.submitSelector);
        } catch (err) {
          await audit('auth_failed', 'pass', {
            reason: 'submit_failed',
            detail: this.detail(ctx, err),
          });
          return { status: 'auth_failed', redacted: true, reason: 'submit_failed' };
        }
      }
      if (
        request.afterSubmitWaitMs !== undefined &&
        request.afterSubmitWaitMs > 0 &&
        page.waitForTimeout
      ) {
        await page.waitForTimeout(request.afterSubmitWaitMs).catch(() => undefined);
      }
      if (request.clearAfterFill === true) await clearInputs(page, request);
    } finally {
      rearm();
      await this.resumeTrace(ctx);
    }

    await audit('success', 'pass', {
      reason: 'success',
      submitted: request.submitSelector !== undefined,
    });
    return { status: 'success', redacted: true };
  }

  // --- internals ------------------------------------------------------------------------------

  private async enterValue(
    ctx: VaultFillContext,
    selector: string,
    value: string,
    rearm: () => void,
  ): Promise<void> {
    const typer = this.deps.typer;
    if (ctx.session.humanize === true && typer !== undefined) {
      // Clear first: typing appends to whatever the field holds, where `fill` replaces it.
      await ctx.page.fill(selector, '', { timeout: FIELD_ENTRY_TIMEOUT_MS });
      await typer(ctx.page, selector, value, { timeoutMs: FIELD_ENTRY_TIMEOUT_MS });
    } else {
      await ctx.page.fill(selector, value, { timeout: FIELD_ENTRY_TIMEOUT_MS });
    }
    rearm();
  }

  /** Holds the fill for an operator (D-15). No gate (stdio) → auto-deny, the safe direction. */
  private async runConfirm(
    ctx: VaultFillContext,
    entry: ResolvedEntry,
    pageUrl: string,
  ): Promise<ConfirmDecision> {
    if (this.deps.confirm === undefined) {
      return { approved: false, reason: 'dashboard_denied', detail: 'no_dashboard' };
    }
    const timeoutMs = this.deps.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
    const handle = await this.deps.confirm.open({
      kind: 'vault_confirm',
      sessionId: ctx.session.sessionId,
      sessionSlug: ctx.session.slug,
      owner: ctx.principal,
      reason: entry.handle,
      entryName: entry.handle,
      tool: 'vault_fill',
      ...(ctx.toolEventId !== undefined &&
        ctx.toolEventId !== null && { toolEventId: ctx.toolEventId }),
      pageUrl,
      ...(timeoutMs > 0 && { timeoutMs }),
      ...(ctx.signal !== undefined && { signal: ctx.signal }),
    });
    const outcome = await handle.promise;
    switch (outcome.status) {
      case 'resolved':
        return { approved: true, reason: 'dashboard_denied', detail: 'approved' };
      case 'timeout':
        return { approved: false, reason: 'confirm_timeout', detail: 'timeout' };
      case 'rejected':
        return {
          approved: false,
          reason: 'dashboard_denied',
          detail: outcome.resolutionReason
            ? `denied: ${outcome.resolutionReason}`
            : 'denied_or_timeout',
        };
      case 'cancelled':
        return { approved: false, reason: 'dashboard_denied', detail: 'cancelled' };
    }
  }

  private async pauseTrace(ctx: VaultFillContext): Promise<void> {
    if (ctx.tracing === null) return;
    try {
      await ctx.tracing.pauseChunk();
    } catch (err) {
      this.log.warn('trace pause failed', { vault: true, session_id: ctx.session.sessionId, err });
    }
  }

  private async resumeTrace(ctx: VaultFillContext): Promise<void> {
    if (ctx.tracing === null) return;
    try {
      await ctx.tracing.resumeChunk();
    } catch (err) {
      this.log.warn('trace resume failed', { vault: true, session_id: ctx.session.sessionId, err });
    }
  }

  /** A secret-free, scrubbed one-line description of a page error for the audit detail. */
  private detail(ctx: VaultFillContext, err: unknown): string {
    const text = err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error';
    return this.deps.redaction.scrub(ctx.session.sessionId, text).slice(0, 500);
  }
}

function blocked(reason: string): VaultFillResult {
  return { status: 'blocked', redacted: true, reason };
}

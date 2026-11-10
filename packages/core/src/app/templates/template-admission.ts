/** @module app/templates/template-admission — `TemplateAdmission` (spec 13 §3.7 `admit`, §6.3 admission order after access): host state, the template cap and the page caps, each refused with its typed, agent-safe code; plus the host-side typed errors. */

import { ERROR_REGISTRY, renderMessage } from '@browserhive/contracts/errors';
import { TEMPLATE_BUSY_LIMIT_TEXT } from '@browserhive/contracts/tools';
import type { PageCaps } from '../../domain/templates/model.ts';
import { AppError } from '../../kernel/errors/app-error.ts';
import type { HostState } from './host-state.ts';

/** How long `TEMPLATE_UNAVAILABLE` and `TEMPLATE_BUSY` ask an agent to wait by default. */
export const DEFAULT_RETRY_AFTER_MS = 5_000;

/** Why a template is briefly unavailable (agent-safe reasons, spec 13 §12). */
export type UnavailableReason = 'starting' | 'restarting' | 'recovering';

/** `TEMPLATE_UNAVAILABLE`. */
export function templateUnavailable(
  template: string,
  reason: UnavailableReason,
  retryAfterMs: number = DEFAULT_RETRY_AFTER_MS,
  message?: string,
): AppError<'TEMPLATE_UNAVAILABLE'> {
  const details = { template, reason, retry_after_ms: Math.max(0, Math.round(retryAfterMs)) };
  return new AppError('TEMPLATE_UNAVAILABLE', details, {
    publicMessage: renderMessage(ERROR_REGISTRY.TEMPLATE_UNAVAILABLE.message, details),
    ...(message !== undefined && { message }),
  });
}

/** `TEMPLATE_DISABLED` `needs_operator` (the host's cause is on operator surfaces only). */
export function templateNeedsOperator(template: string): AppError<'TEMPLATE_DISABLED'> {
  const details = { template, reason: 'needs_operator' as const };
  return new AppError('TEMPLATE_DISABLED', details, {
    publicMessage: renderMessage(ERROR_REGISTRY.TEMPLATE_DISABLED.message, details),
  });
}

/** `TEMPLATE_BUSY` for a capacity or tab limit (spec 13 §6.3). */
export function templateBusy(
  template: string,
  kind: 'capacity' | 'tabs',
  retryAfterMs: number = DEFAULT_RETRY_AFTER_MS,
): AppError<'TEMPLATE_BUSY'> {
  const limitText =
    kind === 'capacity'
      ? TEMPLATE_BUSY_LIMIT_TEXT.capacity(template)
      : TEMPLATE_BUSY_LIMIT_TEXT.tabs();
  const details = {
    template,
    limit_kind: kind,
    limit_text: limitText,
    retry_after_ms: retryAfterMs,
    retry_after_s: Math.max(1, Math.ceil(retryAfterMs / 1000)),
  };
  return new AppError('TEMPLATE_BUSY', details, {
    publicMessage: renderMessage(ERROR_REGISTRY.TEMPLATE_BUSY.message, details),
  });
}

/** What admission decides on. */
export interface AdmissionFacts {
  readonly name: string;
  readonly state: HostState;
  /** Until a crashed host's restart, for `retry_after_ms`. */
  readonly retryAfterMs: number | null;
  /** Live agent virtual sessions plus launches admitted and not finished. */
  readonly agentSessions: number;
  readonly cap: number;
  readonly agentPages: number;
  readonly caps: PageCaps;
}

/**
 * `TemplateAdmission`, run once per launch after access (spec 13 §6.3): a draining host answers
 * `TEMPLATE_UNAVAILABLE` `restarting`, a crashed one `recovering`; a failed one `TEMPLATE_DISABLED`;
 * then the template cap and the host's page cap answer `TEMPLATE_BUSY` (`capacity`). Strategy hooks
 * (T3b) come after; the browser slot is checked at `reserve`, only when the host must start.
 */
export function admitTemplateLaunch(facts: AdmissionFacts): void {
  switch (facts.state) {
    case 'draining':
      throw templateUnavailable(facts.name, 'restarting');
    case 'crashed':
      throw templateUnavailable(
        facts.name,
        'recovering',
        facts.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS,
      );
    case 'failed':
      throw templateNeedsOperator(facts.name);
    default:
      break;
  }
  if (facts.agentSessions >= facts.cap) throw templateBusy(facts.name, 'capacity');
  if (facts.agentPages >= facts.caps.host) throw templateBusy(facts.name, 'capacity');
}

/**
 * The check a virtual session runs before each page it opens itself (`new_tab`, spec 13 §6.3):
 * the host's agent-page cap (`capacity`), then the session's own (`tabs`).
 */
export function admitNewPage(
  name: string,
  caps: PageCaps,
  agentPages: number,
  sessionPages: number,
): void {
  if (agentPages >= caps.host) throw templateBusy(name, 'capacity');
  if (sessionPages >= caps.perSession) throw templateBusy(name, 'tabs');
}

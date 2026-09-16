/** @module domain/session/state — the D-21 session state machine as a discriminated union with a pure `transition`. */

import type { ClosedReason } from '@browserhive/contracts/enums';
import { assertNever } from '../../kernel/errors/app-error.ts';
import { err, ok, type Result } from '../../kernel/result.ts';

/** Named steps of the creation pipeline a `launching` session can be in (D-21). */
export type LaunchPhase =
  | 'prepareProfile'
  | 'resolveIdentity'
  | 'launch'
  | 'installPolicies'
  | 'startTracing'
  | 'applyIdentity'
  | 'register';

/** Why a live session is paused (its sliding lease is frozen while an operator request is open). */
export type PauseReason = 'attention' | 'vault_confirm';

/**
 * `reserved → launching{phase} → live ⇄ paused → draining → closed | crashed`.
 * Every variant carries the epoch-ms instant it was entered.
 */
export type SessionState =
  | { readonly kind: 'reserved'; readonly at: number }
  | { readonly kind: 'launching'; readonly phase: LaunchPhase; readonly at: number }
  | { readonly kind: 'live'; readonly at: number }
  | { readonly kind: 'paused'; readonly reason: PauseReason; readonly at: number }
  | { readonly kind: 'draining'; readonly reason: ClosedReason; readonly at: number }
  | { readonly kind: 'closed'; readonly reason: ClosedReason; readonly at: number }
  | { readonly kind: 'crashed'; readonly detail: string; readonly at: number };

/** The `kind` discriminator; matches the `sessions.state` CHECK list and `SessionStatus`. */
export type SessionStateKind = SessionState['kind'];

/** Inputs that move a session between states. */
export type SessionEvent =
  | { readonly type: 'launch'; readonly phase: LaunchPhase; readonly at: number }
  | { readonly type: 'launched'; readonly at: number }
  | { readonly type: 'pause'; readonly reason: PauseReason; readonly at: number }
  | { readonly type: 'resume'; readonly at: number }
  | { readonly type: 'drain'; readonly reason: ClosedReason; readonly at: number }
  | { readonly type: 'closed'; readonly at: number }
  | { readonly type: 'crash'; readonly detail: string; readonly at: number };

/** The `type` discriminator of {@link SessionEvent}. */
export type SessionEventType = SessionEvent['type'];

/**
 * Why a transition is refused. `SESSION_NOT_LIVE` is the caller's fault (an operator action that
 * needs a running session); `INTERNAL_ERROR` is a programming error (the service drove the machine
 * out of order).
 */
export interface TransitionError {
  readonly code: 'SESSION_NOT_LIVE' | 'INTERNAL_ERROR';
  readonly from: SessionStateKind;
  readonly event: SessionEventType;
  readonly message: string;
}

/** The initial state of a freshly reserved session. */
export function reserved(at: number): SessionState {
  return { kind: 'reserved', at };
}

/** True while tools may drive the session (`live` or `paused`). */
export function canServeTools(state: SessionState): boolean {
  return state.kind === 'live' || state.kind === 'paused';
}

/** True only in `live`. */
export function isLive(state: SessionState): boolean {
  return state.kind === 'live';
}

/** True in `closed` or `crashed`: the browser is gone for good. */
export function isTerminal(state: SessionState): boolean {
  return state.kind === 'closed' || state.kind === 'crashed';
}

/** True while the session still occupies capacity (everything before `closed`/`crashed`). */
export function isOpen(state: SessionState): boolean {
  return !isTerminal(state);
}

/** True while the creation pipeline owns the session. */
export function isLaunching(state: SessionState): boolean {
  return state.kind === 'reserved' || state.kind === 'launching';
}

function refuse(
  code: TransitionError['code'],
  state: SessionState,
  event: SessionEvent,
): Result<SessionState, TransitionError> {
  return err({
    code,
    from: state.kind,
    event: event.type,
    message: `cannot apply '${event.type}' in state '${state.kind}'`,
  });
}

/**
 * Pure transition function. Legal moves:
 * - `launch`: `reserved → launching`, `launching → launching` (phase advance)
 * - `launched`: `launching → live`
 * - `pause`: `live → paused`; `resume`: `paused → live`
 * - `drain`: `reserved | launching | live | paused → draining`
 * - `closed`: `draining → closed`
 * - `crash`: `launching | live | paused → crashed`
 *
 * `draining` never re-enters `live`; `closed`/`crashed` accept nothing.
 */
export function transition(
  state: SessionState,
  event: SessionEvent,
): Result<SessionState, TransitionError> {
  switch (event.type) {
    case 'launch':
      return state.kind === 'reserved' || state.kind === 'launching'
        ? ok({ kind: 'launching', phase: event.phase, at: event.at })
        : refuse('INTERNAL_ERROR', state, event);
    case 'launched':
      return state.kind === 'launching'
        ? ok({ kind: 'live', at: event.at })
        : refuse('INTERNAL_ERROR', state, event);
    case 'pause':
      return state.kind === 'live'
        ? ok({ kind: 'paused', reason: event.reason, at: event.at })
        : refuse('SESSION_NOT_LIVE', state, event);
    case 'resume':
      return state.kind === 'paused'
        ? ok({ kind: 'live', at: event.at })
        : refuse('SESSION_NOT_LIVE', state, event);
    case 'drain':
      return isOpen(state) && state.kind !== 'draining'
        ? ok({ kind: 'draining', reason: event.reason, at: event.at })
        : refuse('SESSION_NOT_LIVE', state, event);
    case 'closed':
      return state.kind === 'draining'
        ? ok({ kind: 'closed', reason: state.reason, at: event.at })
        : refuse('INTERNAL_ERROR', state, event);
    case 'crash':
      return state.kind === 'launching' || state.kind === 'live' || state.kind === 'paused'
        ? ok({ kind: 'crashed', detail: event.detail, at: event.at })
        : refuse('INTERNAL_ERROR', state, event);
    default:
      return assertNever(event);
  }
}

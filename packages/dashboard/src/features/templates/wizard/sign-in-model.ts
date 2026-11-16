/** @module features/templates/wizard/sign-in-model — the sign-in step's pure rules (spec 13 §7.1): which open session is the recording window, and which error state a failed or interrupted sign-in is in, from the error and the template's browser */
import type { HostView, SessionSummary, Template } from '@browserhive/contracts/http';
import type { AppError } from '@/lib/api/errors.ts';

/** The recording window's session: a live maintenance session of the template with the `recording` slug. */
export function recordingSessionOf(sessions: readonly SessionSummary[]): SessionSummary | null {
  return (
    sessions.find((s) => s.live && s.template?.mode === 'maintenance' && s.slug === 'recording') ??
    null
  );
}

/** An error state of the sign-in step, each with its own copy and action. */
export type SignInProblem =
  | { readonly kind: 'no_display' }
  | { readonly kind: 'proxy_unreachable'; readonly proxy: string | null }
  | { readonly kind: 'session_limit' }
  | { readonly kind: 'not_installed'; readonly command: string | null }
  | { readonly kind: 'sandbox' }
  | { readonly kind: 'disabled' }
  | { readonly kind: 'crashed' }
  | { readonly kind: 'other'; readonly message: string; readonly code: string | null };

function detail(error: AppError, key: string): string | null {
  const value = error.details[key];
  return typeof value === 'string' ? value : null;
}

/**
 * The step's error state. `error` is the last failed "open the window"; `host` and `template` the
 * latest reads; `windowLost` is true when a window this page saw open is gone while the browser is
 * not running (a crash, spec 13 §3.2). `null`: nothing is wrong.
 */
export function signInProblem(input: {
  readonly error: AppError | null;
  readonly host: HostView | undefined;
  readonly template: Template | undefined;
  readonly windowLost: boolean;
}): SignInProblem | null {
  const { error, host, template } = input;
  if (host?.state === 'failed') {
    if (host.last_error === 'no_display') return { kind: 'no_display' };
    if (host.last_error === 'proxy_unreachable')
      return { kind: 'proxy_unreachable', proxy: template?.proxy?.server ?? null };
    if (host.last_error === 'sandbox_unavailable') return { kind: 'sandbox' };
  }
  if (error !== null) {
    if (error.code === 'SESSION_LIMIT_REACHED') return { kind: 'session_limit' };
    if (error.code === 'BROWSER_NOT_INSTALLED')
      return { kind: 'not_installed', command: detail(error, 'install_command') };
    if (error.code === 'SANDBOX_UNAVAILABLE') return { kind: 'sandbox' };
    if (template?.status === 'disabled' || error.code === 'TEMPLATE_DISABLED')
      return template?.status === 'disabled'
        ? { kind: 'disabled' }
        : { kind: 'other', message: host?.last_error ?? error.message, code: error.code };
    return { kind: 'other', message: error.message, code: error.code };
  }
  if (template?.status === 'disabled') return { kind: 'disabled' };
  if (input.windowLost && (host?.state === 'crashed' || host?.state === 'stopped'))
    return { kind: 'crashed' };
  if (host?.state === 'failed')
    return {
      kind: 'other',
      message: host.last_error ?? 'The browser failed to start.',
      code: null,
    };
  return null;
}

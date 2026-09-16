/** @module features/sessions/session-format — small display helpers shared by the sessions list and the session page */

/** Browser description shown only when it differs from the default (`chromium`, headless). */
export function browserLabel(session: {
  readonly channel: string;
  readonly headless: boolean;
  readonly incognito: boolean;
}): string | null {
  const parts: string[] = [];
  if (session.channel !== 'chromium') parts.push(session.channel);
  if (!session.headless) parts.push('headed');
  if (session.incognito) parts.push('incognito');
  return parts.length === 0 ? null : parts.join(' · ');
}

/** Why a session closed, as a sentence fragment ("Closed by the agent"). */
export function closedReasonText(reason: string | null): string {
  switch (reason) {
    case 'user':
      return 'Closed by the agent';
    case 'operator':
      return 'Closed from the dashboard';
    case 'lease_expired':
      return 'Closed when its lease expired';
    case 'crash':
      return 'The browser crashed';
    case 'shutdown':
      return 'Closed when the daemon shut down';
    case 'interrupted':
      return 'Interrupted when the daemon stopped unexpectedly';
    case 'launch_failed':
      return 'The browser failed to launch';
    default:
      return 'Closed';
  }
}

/**
 * Session age for a meta line that should not reflow every second: seconds under a minute, whole
 * minutes under an hour, then hours and minutes.
 */
export function coarseDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest === 0 ? `${h}h` : `${h}h ${rest}m`;
}

/** A session that no longer runs a browser: closed, crashed, or closing (`draining`). */
export function sessionEnded(session: { readonly live: boolean; readonly state: string }): boolean {
  return !session.live || session.state === 'draining';
}

/** The closed reason as a short note beside a "closed" state badge ("by the agent"). */
export function closedReasonNote(reason: string | null): string | null {
  switch (reason) {
    case 'user':
      return 'by the agent';
    case 'operator':
      return 'from the dashboard';
    case 'lease_expired':
      return 'lease ran out';
    case 'crash':
      return 'browser crashed';
    case 'shutdown':
      return 'daemon shut down';
    case 'interrupted':
      return 'daemon stopped unexpectedly';
    case 'launch_failed':
      return 'launch failed';
    default:
      return null;
  }
}

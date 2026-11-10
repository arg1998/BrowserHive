/** @module features/templates/live — keeps template queries current: the `templates` topic (spec 13 §11.3) once the server serves it, and the `sessions` topic for live counts (a template session opening or closing changes `in_use`) */
import { WS_STATIC_TOPICS, type WsFeedEvent } from '@browserhive/contracts/ws';
import { useQueryClient } from '@tanstack/react-query';
import { useTopic } from '@/app/providers/SocketProvider.tsx';
import { keys } from '@/lib/api/keys.ts';

/**
 * The `templates` topic when these contracts know it (T1b adds it to `WS_STATIC_TOPICS`), else
 * `null`: subscribing to a topic the server does not serve is refused, so until then pages poll
 * where they must (the sign-in step, a running restore).
 */
export const TEMPLATES_TOPIC: string | null = (WS_STATIC_TOPICS as readonly string[]).includes(
  'templates',
)
  ? 'templates'
  : null;

/** `true` while template changes arrive over the socket (no polling needed). */
export const TEMPLATES_LIVE = TEMPLATES_TOPIC !== null;

/** The event's type, read without assuming which events these contracts know. */
function eventType(event: WsFeedEvent): string {
  return (event as { readonly type: string }).type;
}

/** `true` for a session event about a template session (`in_use`, the Sessions tab). */
export function isTemplateSessionEvent(event: WsFeedEvent): boolean {
  if (!eventType(event).startsWith('session.')) return false;
  const session = (event as { readonly session?: { readonly template?: unknown } }).session;
  // `session.removed` carries only an id: refresh, it may have been a template's.
  return session === undefined || session.template !== undefined;
}

/** Subscribe the page to template changes; every relevant event refreshes the template queries. */
export function useTemplatesLive(): void {
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: keys.templates.all });
  useTopic(TEMPLATES_TOPIC, (event) => {
    if (eventType(event).startsWith('template.')) refresh();
  });
  useTopic('sessions', (event) => {
    if (isTemplateSessionEvent(event)) refresh();
  });
}

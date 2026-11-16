/** @module features/templates/live — keeps template queries current over the `templates` topic (spec 13 §11.3): a browser's state patches the cached detail in place, a site's health patches its card, versions and operations refresh their own queries, and changes or removals refresh the lists and that template; the `sessions` topic refreshes live counts when a template session opens or closes. Each event touches only the queries of its template */
import type { TemplateDetailResponse } from '@browserhive/contracts/http';
import type { WsFeedEvent } from '@browserhive/contracts/ws';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useTopic } from '@/app/providers/SocketProvider.tsx';
import { keys } from '@/lib/api/keys.ts';

/** The topic (T1b serves it; the constant keeps the subscriptions in one place). */
export const TEMPLATES_TOPIC = 'templates';

/** `true`: template changes arrive over the socket; polling only backs it up. */
export const TEMPLATES_LIVE = true;

/** Lists, the overview (sidebar badge, `/system`) and one template's detail. */
function refreshTemplate(qc: QueryClient, templateId: string | null): void {
  void qc.invalidateQueries({ queryKey: keys.templates.lists() });
  void qc.invalidateQueries({ queryKey: keys.templates.overview() });
  void qc.invalidateQueries({
    queryKey: templateId === null ? keys.templates.details() : keys.templates.detail(templateId),
  });
}

/** Apply one `templates` event to the cache (pure on the client; tested). */
export function applyTemplateEvent(qc: QueryClient, event: WsFeedEvent): void {
  switch (event.type) {
    case 'template.changed':
      refreshTemplate(qc, event.template.template_id);
      return;
    case 'template.removed':
      qc.removeQueries({ queryKey: keys.templates.detail(event.template_id) });
      void qc.invalidateQueries({ queryKey: keys.templates.lists() });
      void qc.invalidateQueries({ queryKey: keys.templates.overview() });
      return;
    case 'template.host': {
      const key = keys.templates.detail(event.template_id);
      const cached = qc.getQueryData<TemplateDetailResponse>(key);
      if (cached !== undefined) qc.setQueryData(key, { ...cached, host: event.host });
      void qc.invalidateQueries({ queryKey: keys.templates.lists() });
      void qc.invalidateQueries({ queryKey: keys.templates.overview() });
      return;
    }
    case 'template.health': {
      const key = keys.templates.detail(event.template_id);
      const cached = qc.getQueryData<TemplateDetailResponse>(key);
      if (cached !== undefined) {
        const replace = <T extends { readonly site_id: string }>(sites: readonly T[]) =>
          sites.map((s) => (s.site_id === event.site.site_id ? { ...s, ...event.site } : s));
        qc.setQueryData(key, {
          ...cached,
          sites: replace(cached.sites),
          template: { ...cached.template, sites: replace(cached.template.sites) },
        });
      }
      void qc.invalidateQueries({ queryKey: keys.templates.lists() });
      void qc.invalidateQueries({ queryKey: keys.templates.overview() });
      return;
    }
    case 'template.version':
      void qc.invalidateQueries({ queryKey: keys.templates.versions(event.template_id) });
      return;
    case 'template.operation':
      void qc.invalidateQueries({ queryKey: keys.templates.operation(event.operation_id) });
      if (event.state !== 'running') {
        void qc.invalidateQueries({ queryKey: keys.templates.versions(event.template_id) });
        refreshTemplate(qc, event.template_id);
      }
      return;
    default:
      return;
  }
}

/** The template a session event is about, `undefined` when it is not a template session's. */
export function templateOfSessionEvent(event: WsFeedEvent): string | null | undefined {
  switch (event.type) {
    case 'session.opened':
      return event.session.template === undefined
        ? undefined
        : (event.session.template.template_id ?? null);
    case 'session.closed':
      // The event carries no template: refresh the lists and every cached template.
      return null;
    default:
      // `session.updated` (activity, lease) and `session.removed` (archive) leave live counts alone.
      return undefined;
  }
}

/** Subscribe the page to template changes. */
export function useTemplatesLive(): void {
  const qc = useQueryClient();
  useTopic(TEMPLATES_TOPIC, (event) => applyTemplateEvent(qc, event));
  useTopic('sessions', (event) => {
    const templateId = templateOfSessionEvent(event);
    if (templateId !== undefined) refreshTemplate(qc, templateId);
  });
}

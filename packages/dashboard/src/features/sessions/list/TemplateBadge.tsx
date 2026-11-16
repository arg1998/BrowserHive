/** @module features/sessions/list/TemplateBadge — the template a session was launched from, as a small badge beside its slug in the list and on cards: the template's display name (the name at launch when the template is gone); it wraps under the slug rather than squeezing it */
import type { SessionSummary } from '@browserhive/contracts/http';
import { useTemplatesOverview } from '@/features/templates/api.ts';
import { ICONS } from '@/lib/icons.ts';

/** The template a session was launched from (spec 13 §11.4 "Session with a Template badge"). */
export function TemplateBadge({ session }: { readonly session: SessionSummary }) {
  const overview = useTemplatesOverview(session.template !== undefined);
  if (session.template === undefined) return null;
  const id = session.template.template_id;
  const label =
    overview.data?.data.find((t) => t.template_id === id)?.display_name ?? session.template.name;
  const Icon = ICONS.templates;
  return (
    <span className="inline-flex h-5.5 max-w-full min-w-0 items-center gap-1 rounded-md bg-muted px-1.5 text-xs font-medium text-muted-foreground">
      <Icon aria-hidden="true" className="size-3 shrink-0" />
      <span className="sr-only">Template </span>
      <span className="truncate">{label}</span>
    </span>
  );
}

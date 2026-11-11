/** @module features/sessions/list/TemplateBadge — the template a session was launched from, as a small badge beside its slug in the list and on cards (never truncated away by the id line) */
import type { SessionSummary } from '@browserhive/contracts/http';
import { ICONS } from '@/lib/icons.ts';

/** The template a session was launched from, as a small badge beside the slug (spec 13 §11.4 "Session with a Template badge"). */
export function TemplateBadge({ session }: { readonly session: SessionSummary }) {
  if (session.template === undefined) return null;
  const Icon = ICONS.templates;
  return (
    <span className="inline-flex h-5.5 max-w-[11rem] shrink-0 items-center gap-1 rounded-md bg-muted px-1.5 text-xs font-medium text-muted-foreground">
      <Icon aria-hidden="true" className="size-3 shrink-0" />
      <span className="sr-only">Template </span>
      <span className="truncate">{session.template.name}</span>
    </span>
  );
}

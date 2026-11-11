/** @module features/system/status/DegradationMessage — a degradation's sentence on System › Status; template degradations name the template by its display name and link to it instead of showing the internal id and reason (spec 13 §11.4 vocabulary) */
import type { SystemEvent } from '@browserhive/contracts/http';
import { Link } from '@tanstack/react-router';
import { useTemplatesOverview } from '@/features/templates/api.ts';
import { templateDegradationText, templatesOf } from '@/features/templates/degradations.ts';

/** The event's message, or a plain sentence with a link for a template's. */
export function DegradationMessage({ event }: { readonly event: SystemEvent }) {
  const ids = templatesOf(event);
  const overview = useTemplatesOverview(ids.length > 0);
  const row = overview.data?.data.find((t) => ids.includes(t.template_id));
  const text = row === undefined ? null : templateDegradationText(event, row.display_name);
  if (row === undefined || text === null)
    return <p className="text-base [overflow-wrap:anywhere]">{event.message}</p>;
  return (
    <p className="text-base text-pretty">
      {text}{' '}
      <Link
        to="/templates/$id"
        params={{ id: row.template_id }}
        className="text-link underline decoration-link/40 underline-offset-2 hover:decoration-link"
      >
        Open {row.display_name}
      </Link>
    </p>
  );
}

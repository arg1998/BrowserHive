/** @module features/templates/list/TemplateCard — a template under 768px (the whole card is the row link): name, status, sites with their health, Browser and sessions, Continue sign-in while setting up */
import type { TemplateSummary } from '@browserhive/contracts/http';
import type { ReactNode } from 'react';
import { SiteChips } from '../SiteChips.tsx';
import { BrowserCell, SessionsCell, TemplateTitleCell } from './templates-columns.tsx';

/** Card. */
export function TemplateCard({
  template,
  actions,
  footer,
}: {
  readonly template: TemplateSummary;
  readonly actions: ReactNode;
  /** Under the facts (Continue sign-in while setting up). */
  readonly footer?: ReactNode;
}) {
  return (
    <article className="flex flex-col gap-3" aria-label={template.display_name} data-band="card">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <TemplateTitleCell template={template} inlineSessions={false} />
        </div>
        <div className="-mt-1 -mr-2 flex shrink-0 items-center gap-1">{actions}</div>
      </div>
      <SiteChips sites={template.sites} max={4} />
      <div className="flex items-start justify-between gap-3">
        <BrowserCell template={template} />
        <SessionsCell template={template} />
      </div>
      {footer}
    </article>
  );
}

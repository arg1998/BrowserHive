/** @module features/templates/list/templates-columns — `/templates` columns (spec 13 §11.4): Template (display name over `name` in mono, Setting up / Disabled, identity drift) · Sites (a chip per site with its sign-in health) · Browser (state and pages) · Sessions (`in_use / cap`) · Last used · actions (Continue sign-in while setting up, the menu). Columns follow the table's own width: Browser from 44rem, Sessions from 38rem, Last used from 60rem (they fold into the Template cell below that) */
import type { TemplateSummary } from '@browserhive/contracts/http';
import type { ReactNode } from 'react';
import { Chip } from '@/components/shared/Chip.tsx';
import { RelativeTime } from '@/components/shared/RelativeTime.tsx';
import { StatusBadge } from '@/components/shared/StatusBadge.tsx';
import type { DataTableColumn } from '@/components/shared/use-data-table.ts';
import { cn } from '@/lib/utils.ts';
import { capText, pagesText, signInsNeeded } from '../model.ts';
import { SiteChips } from '../SiteChips.tsx';

/** Template cell: display name (the row link's text) over the agent-facing name and what needs care. */
export function TemplateTitleCell({
  template,
  inlineSessions = true,
}: {
  readonly template: TemplateSummary;
  /** Fold the session count into the name line while the Sessions column is hidden. */
  readonly inlineSessions?: boolean;
}) {
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate text-base leading-5 font-medium text-foreground decoration-muted-foreground/60 underline-offset-4 group-hover/row:underline">
          {template.display_name}
        </span>
        {template.status !== 'ready' ? (
          <StatusBadge
            domain="templateStatus"
            value={template.status}
            variant="pill"
            iconless
            className="shrink-0"
          />
        ) : null}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-sm leading-5 text-muted-foreground">
        <span className="truncate font-mono">{template.name}</span>
        {inlineSessions ? (
          <span className="truncate @min-[38rem]:hidden">
            · {capText(template.in_use, template.cap)} sessions
          </span>
        ) : null}
        {template.status === 'ready' && signInsNeeded(template) > 0 ? (
          <Chip tone="warn" className="shrink-0">
            {signInsNeeded(template)} {signInsNeeded(template) === 1 ? 'site' : 'sites'} signed out
          </Chip>
        ) : null}
        {template.identity_drift !== undefined ? (
          <Chip tone="warn" className="shrink-0">
            Browser changed
          </Chip>
        ) : null}
      </span>
    </span>
  );
}

/** Browser: state dot and label over the agent pages it holds. */
export function BrowserCell({ template }: { readonly template: TemplateSummary }) {
  const pages = pagesText(template.host.state, template.host.pages);
  return (
    <span className="flex min-w-0 flex-col">
      <StatusBadge domain="templateHost" value={template.host.state} className="leading-5" />
      {pages !== null ? (
        <span className="pl-4 text-sm leading-5 text-muted-foreground">{pages}</span>
      ) : null}
    </span>
  );
}

/** Sessions: live agent sessions against the cap, with a thin meter. */
export function SessionsCell({ template }: { readonly template: TemplateSummary }) {
  const ratio = template.cap > 0 ? Math.min(1, template.in_use / template.cap) : 0;
  const full = template.in_use >= template.cap && template.cap > 0;
  return (
    <span className="flex w-20 min-w-0 flex-col gap-1">
      <span
        className={cn(
          'text-sm leading-5 tabular-nums',
          full ? 'text-warn-text' : 'text-foreground',
        )}
      >
        {capText(template.in_use, template.cap)}
      </span>
      <span aria-hidden="true" className="h-1 w-full overflow-hidden rounded-full bg-muted">
        <span
          className={cn('block h-full rounded-full', full ? 'bg-warn-solid' : 'bg-primary/70')}
          style={{ width: `${ratio * 100}%` }}
        />
      </span>
    </span>
  );
}

/** Column set; `actions` renders the trailing cell. */
export function templateColumns(
  actions: (template: TemplateSummary) => ReactNode,
): readonly DataTableColumn<TemplateSummary>[] {
  return [
    {
      id: 'name',
      header: 'Template',
      sortable: true,
      priority: 1,
      className: 'w-[13rem] min-w-[11rem] max-w-[18rem] py-2 @min-[60rem]:w-[16rem]',
      cell: (t) => <TemplateTitleCell template={t} />,
    },
    {
      id: 'sites',
      header: 'Sites',
      priority: 1,
      grow: true,
      className: 'min-w-[9rem] py-2 [&>*]:max-w-[44rem]',
      cell: (t) => <SiteChips sites={t.sites} wideMax={8} />,
    },
    {
      id: 'browser',
      header: 'Browser',
      priority: 1,
      nowrap: true,
      className: 'hidden w-32 py-2 @min-[44rem]:table-cell',
      cell: (t) => <BrowserCell template={t} />,
    },
    {
      id: 'sessions',
      header: 'Sessions',
      sortable: true,
      priority: 1,
      className: 'hidden w-28 py-2 @min-[38rem]:table-cell',
      cell: (t) => <SessionsCell template={t} />,
    },
    {
      id: 'used',
      header: 'Last used',
      sortable: true,
      priority: 1,
      nowrap: true,
      className: 'hidden w-28 py-2 text-muted-foreground @min-[60rem]:table-cell',
      cell: (t) =>
        t.last_used_at !== null ? (
          <RelativeTime at={t.last_used_at} className="text-sm" />
        ) : (
          <span className="text-sm text-subtle-foreground">Never</span>
        ),
    },
    {
      id: 'actions',
      header: 'Actions',
      priority: 1,
      align: 'end',
      hideHeader: true,
      cell: actions,
      className: 'w-[3.5rem] py-2 @min-[44rem]:w-auto',
    },
  ];
}

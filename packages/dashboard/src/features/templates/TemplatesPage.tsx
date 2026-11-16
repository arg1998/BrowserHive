/** @module features/templates/TemplatesPage — `/templates` (spec 13 §11.4, spec 04 §12.14): header with **New template**, status and browser chips with search, a whole-row linked table (cards under 768px) of every template with its sites' sign-in health, browser, sessions and last use; a template still being set up offers **Continue sign-in**; the first visit explains templates in three steps */
import type { TemplateSummary } from '@browserhive/contracts/http';
import { Link } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo } from 'react';
import { DataPanel } from '@/components/shared/DataPanel.tsx';
import { DataTable } from '@/components/shared/DataTable.tsx';
import { type FacetChip, FilterBar } from '@/components/shared/FilterBar.tsx';
import { Stack } from '@/components/shared/layout.tsx';
import { PageHeader } from '@/components/shared/PageHeader.tsx';
import { useRowControlTabIndex } from '@/components/shared/row-context.ts';
import { SkeletonTable } from '@/components/shared/Skeletons.tsx';
import { Button, buttonVariants } from '@/components/ui/button.tsx';
import { Hint } from '@/components/ui/tooltip.tsx';
import { useCursorPage } from '@/features/sessions/use-cursor-page.ts';
import { formatNumber } from '@/lib/format/bytes.ts';
import { ICONS } from '@/lib/icons.ts';
import { useSearchState } from '@/lib/search/use-search-state.ts';
import { TEMPLATE_HOST, TEMPLATE_STATUS } from '@/lib/status-registry.ts';
import { useTemplatesList } from './api.ts';
import { TemplateCard } from './list/TemplateCard.tsx';
import { TemplatesEmpty, TemplatesIntro } from './list/TemplatesEmpty.tsx';
import { templateColumns } from './list/templates-columns.tsx';
import { useTemplatesLive } from './live.ts';
import { signInsNeeded } from './model.ts';
import {
  hasTemplateFilters,
  TEMPLATE_FILTER_KEYS,
  TEMPLATE_SORT_KEYS,
  type TemplatesSearch,
  toTemplatesQuery,
} from './search.ts';
import { TemplateMenu } from './TemplateMenu.tsx';
import { useTemplateActions } from './use-template-actions.ts';

/** Header line: how many templates and how many sites need a sign-in. */
export function templatesCountText(rows: readonly TemplateSummary[], total: number): string {
  const needs = rows.reduce((n, t) => n + signInsNeeded(t), 0);
  const base = `${formatNumber(total)} ${total === 1 ? 'template' : 'templates'}`;
  return needs > 0
    ? `${base} · ${needs} ${needs === 1 ? 'site needs' : 'sites need'} a sign-in`
    : base;
}

/** Trailing cell: Continue sign-in while setting up, then the menu. */
function RowActions({
  template,
  compact = false,
}: {
  readonly template: TemplateSummary;
  readonly compact?: boolean;
}) {
  const actions = useTemplateActions(template);
  const rowTabIndex = useRowControlTabIndex();
  const SignIn = ICONS.signIn;
  return (
    <span className="inline-flex items-center gap-1">
      {template.status === 'recording' && !compact ? (
        <>
          <Button
            type="button"
            variant="outline"
            size="sm"
            tabIndex={rowTabIndex}
            className="hidden @min-[64rem]:inline-flex"
            onClick={actions.continueSignIn}
          >
            <SignIn aria-hidden="true" />
            Continue sign-in
          </Button>
          <Hint label="Continue sign-in">
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              tabIndex={rowTabIndex}
              aria-label={`Continue sign-in to ${template.display_name}`}
              className="@min-[64rem]:hidden"
              onClick={actions.continueSignIn}
            >
              <SignIn aria-hidden="true" />
            </Button>
          </Hint>
        </>
      ) : null}
      <TemplateMenu template={template} />
    </span>
  );
}

/** A card's Continue sign-in (cards have room for the label). */
function CardFooter({ template }: { readonly template: TemplateSummary }) {
  const actions = useTemplateActions(template);
  const SignIn = ICONS.signIn;
  if (template.status !== 'recording') return null;
  return (
    <Button type="button" variant="outline" className="w-full" onClick={actions.continueSignIn}>
      <SignIn aria-hidden="true" />
      Continue sign-in
    </Button>
  );
}

/** Templates list. */
export function TemplatesPage() {
  const { search, set, clear } = useSearchState<TemplatesSearch>();
  const signature = JSON.stringify(toTemplatesQuery({ ...search, page: 1 }, undefined));
  const resetPage = useCallback(() => set({ page: undefined }), [set]);
  const cursorPage = useCursorPage(signature, search.page, resetPage);
  const query = useTemplatesList(search, cursorPage.cursor, cursorPage.known);
  const nextCursor = query.data?.page.next_cursor;
  useEffect(() => {
    if (nextCursor !== undefined) cursorPage.remember(search.page, nextCursor);
  }, [nextCursor, search.page, cursorPage]);
  useTemplatesLive();
  const filtered = hasTemplateFilters(search);
  const onClear = useCallback(() => clear(['ps', 'sort', 'dir']), [clear]);
  const columns = useMemo(() => templateColumns((t) => <RowActions template={t} />), []);
  const facets = query.data?.facets;
  const chips: FacetChip[] = [
    {
      param: 'status',
      label: 'Status',
      options: facets?.status ?? [],
      selected: search.status ?? [],
      format: (value: string) =>
        TEMPLATE_STATUS[value as keyof typeof TEMPLATE_STATUS]?.label ?? value,
    },
    {
      param: 'host',
      label: 'Browser',
      options: facets?.host_state ?? [],
      selected: search.host ?? [],
      format: (value: string) => TEMPLATE_HOST[value as keyof typeof TEMPLATE_HOST]?.label ?? value,
    },
  ].filter((chip) => chip.options.length > 1 || chip.selected.length > 0);
  const total = query.data?.page.total;
  const firstVisit = !filtered && total === 0 && search.page === 1;
  const Plus = ICONS.plus;

  return (
    <Stack gap={4}>
      <PageHeader
        title="Templates"
        description={
          !filtered && total !== undefined && total > 0 && query.data !== undefined
            ? templatesCountText(query.data.data, total)
            : 'Signed-in browsers agents launch sessions from.'
        }
        learnMore={
          <>
            <p>
              A template is a browser you signed in to once. Every session launched from it is a
              window of that one browser, so agents share the sign-in without ever handling a
              password, and they cannot copy the cookies out.
            </p>
            <p>
              The browser runs on the machine running BrowserHive. It starts when an agent or a
              sign-in needs it and stops after an hour without sessions.
            </p>
          </>
        }
        learnMoreDocs="dashboardTemplates"
        actions={
          firstVisit ? undefined : (
            <Link to="/templates/new" className={buttonVariants({ size: 'default' })}>
              <Plus aria-hidden="true" />
              New template
            </Link>
          )
        }
      />
      {firstVisit ? (
        <div className="rounded-xl border bg-card shadow-xs dark:shadow-none">
          <TemplatesIntro />
        </div>
      ) : (
        <>
          <FilterBar
            search={{ param: 'q', placeholder: 'Search templates…', value: search.q }}
            chips={chips}
            {...(filtered && total !== undefined && { matching: total })}
            onChange={(param, value) => set({ [param]: value })}
            onClear={onClear}
          />
          <DataPanel query={query} skeleton={<SkeletonTable />} isEmpty={() => false} empty={null}>
            {(page) => (
              <div className="@container min-w-0">
                <DataTable<TemplateSummary>
                  label="Templates"
                  columns={columns}
                  rows={page.data}
                  {...(page.page.total !== undefined && { rowCount: page.page.total })}
                  hasNext={page.page.next_cursor !== null}
                  state={{
                    page: search.page,
                    pageSize: search.ps,
                    sort: search.sort,
                    dir: search.dir,
                  }}
                  sortKeys={TEMPLATE_SORT_KEYS}
                  getRowId={(row) => row.template_id}
                  onStateChange={(patch) => set(patch)}
                  rowHref={(row) => `/templates/${encodeURIComponent(row.template_id)}`}
                  rowLabel={(row) => row.display_name}
                  loading={query.isPending}
                  emptyState={<TemplatesEmpty filtered={filtered} onClear={onClear} />}
                  renderCard={(row) => (
                    <TemplateCard
                      template={row}
                      actions={<RowActions template={row} compact />}
                      footer={<CardFooter template={row} />}
                    />
                  )}
                />
              </div>
            )}
          </DataPanel>
        </>
      )}
    </Stack>
  );
}

/** Keys "Clear all" removes (documented for tests). */
export const CLEARED_KEYS = TEMPLATE_FILTER_KEYS;

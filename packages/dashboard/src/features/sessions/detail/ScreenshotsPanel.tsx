/** @module features/sessions/detail/ScreenshotsPanel — Screenshots tab: agent captures and trace frames as a thumbnail grid opening the zoom modal, each card naming the page it captured (title, host, time, from the session's page visits) with dims and size; kind switch; the pager only when there is more than one page */
import { type PageRow, ScreenshotKind } from '@browserhive/contracts/http';
import { useEffect } from 'react';
import { useApi } from '@/app/providers/AuthProvider.tsx';
import { EmptyState } from '@/components/shared/EmptyState.tsx';
import { ErrorState } from '@/components/shared/ErrorState.tsx';
import { Pagination } from '@/components/shared/Pagination.tsx';
import { splitUrl } from '@/components/shared/url-cell.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group.tsx';
import { toAppError } from '@/lib/api/errors.ts';
import { formatBytes, formatNumber } from '@/lib/format/bytes.ts';
import { formatClock } from '@/lib/format/time.ts';
import { useSearchState } from '@/lib/search/use-search-state.ts';
import { ScreenshotThumb } from '../activity/ScreenshotThumb.tsx';
import { useScreenshotPageContext, useSessionScreenshotsQuery } from '../api.ts';
import type { SessionPageSearch } from '../detail-search.ts';
import { useCursorPage } from '../use-cursor-page.ts';

const KIND_LABEL = { tool: 'Agent captures', trace: 'Trace frames' } as const;

/**
 * Card title: what produced the picture, in words ("Screenshot", "Trace frame · click"), instead of
 * the same mono `screenshot` on every card.
 */
export function shotTitle(shot: { readonly tool: string; readonly kind: string }): string {
  const tool = shot.tool.replaceAll('_', ' ');
  if (shot.kind === 'trace') return `Trace frame · ${tool}`;
  return shot.tool === 'screenshot' ? 'Screenshot' : `Capture · ${tool}`;
}

/** The page a capture shows: the latest visit at or before `ts` (`visits` newest first). */
export function pageAt(
  visits: readonly Pick<PageRow, 'ts' | 'url' | 'title'>[] | undefined,
  ts: number,
): { readonly host: string; readonly title: string | null } | null {
  const visit = visits?.find((v) => v.ts <= ts);
  if (visit === undefined) return null;
  const title = visit.title?.trim();
  return {
    host: splitUrl(visit.url).host,
    title: title === undefined || title === '' ? null : title,
  };
}

/** Screenshots tab. */
export function ScreenshotsPanel({ sessionId }: { readonly sessionId: string }) {
  const api = useApi();
  const { search, set } = useSearchState<SessionPageSearch>();
  const signature = JSON.stringify([sessionId, search.shots, search.ps]);
  const cursorPage = useCursorPage(signature, search.page, () => set({ page: undefined }));
  const query = useSessionScreenshotsQuery(
    sessionId,
    {
      limit: search.ps,
      total: true,
      ...(cursorPage.cursor !== undefined && { cursor: cursorPage.cursor }),
      ...(search.shots !== undefined && { kind: search.shots }),
    },
    cursorPage.known,
  );
  const next = query.data?.page.next_cursor;
  const { remember } = cursorPage;
  useEffect(() => {
    if (next !== undefined) remember(search.page, next);
  }, [next, remember, search.page]);
  const shots = query.data?.data;
  const newest =
    shots === undefined || shots.length === 0 ? undefined : Math.max(...shots.map((x) => x.ts));
  const context = useScreenshotPageContext(sessionId, newest);
  const kind = search.shots?.length === 1 ? search.shots[0] : 'all';
  const total = query.data?.page.total;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ToggleGroup
          aria-label="Screenshot kind"
          size="sm"
          spacing={0}
          value={[kind ?? 'all']}
          onValueChange={(value: readonly string[]) => {
            const picked = ScreenshotKind.safeParse(value[0]);
            set({ shots: picked.success ? [picked.data] : undefined });
          }}
        >
          <ToggleGroupItem value="all">All</ToggleGroupItem>
          {ScreenshotKind.options.map((k) => (
            <ToggleGroupItem key={k} value={k}>
              {KIND_LABEL[k]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {total !== undefined && total > 0 ? (
          <span className="text-sm text-muted-foreground tabular-nums">
            {formatNumber(total)} {total === 1 ? 'screenshot' : 'screenshots'}
          </span>
        ) : null}
      </div>
      {query.isPending ? (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-4" aria-busy="true">
          {Array.from({ length: 6 }, (_, i) => (
            <li key={`s${String(i)}`} className="flex flex-col gap-2">
              <Skeleton className="aspect-video w-full rounded-lg" />
              <Skeleton className="h-4 w-32" />
            </li>
          ))}
        </ul>
      ) : query.isError ? (
        <ErrorState
          tier="region"
          error={toAppError(query.error)}
          onRetry={() => void query.refetch()}
        />
      ) : query.data.data.length === 0 ? (
        <div className="rounded-xl border bg-card">
          <EmptyState
            kind={search.shots !== undefined ? 'zero-results' : 'zero-data'}
            icon="image"
            title={
              search.shots !== undefined
                ? `No ${KIND_LABEL[search.shots[0] ?? 'tool'].toLowerCase()}`
                : 'No screenshots yet'
            }
            description="Screenshots appear when the agent calls the screenshot tool, and as trace frames once a traced session closes."
            {...(search.shots !== undefined && { onClear: () => set({ shots: undefined }) })}
          />
        </div>
      ) : (
        <>
          <ul
            className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-x-4 gap-y-5"
            aria-label="Screenshots"
          >
            {query.data.data.map((shot) => (
              <li key={shot.event_id} className="flex min-w-0 flex-col gap-2">
                <ScreenshotThumb
                  variant="card"
                  src={
                    shot.url ??
                    api.url('getScreenshotImage', {
                      session_id: sessionId,
                      event_id: shot.event_id,
                    })
                  }
                  tool={shot.tool}
                  ts={shot.ts}
                  width={shot.width}
                  height={shot.height}
                  sizeBytes={shot.size_bytes}
                  kind={shot.kind}
                />
                <ShotCaption shot={shot} page={pageAt(context.data, shot.ts)} />
              </li>
            ))}
          </ul>
          <Pagination
            page={search.page}
            pageSize={search.ps}
            {...(total !== undefined && { total })}
            hasNext={query.data.page.next_cursor !== null}
            onPage={(page) => set({ page })}
            onPageSize={(ps) => set({ ps })}
          />
        </>
      )}
    </div>
  );
}

function ShotCaption({
  shot,
  page,
}: {
  readonly shot: {
    readonly tool: string;
    readonly kind: string;
    readonly ts: number;
    readonly width: number;
    readonly height: number;
    readonly size_bytes: number;
  };
  readonly page: ReturnType<typeof pageAt>;
}) {
  const heading = page?.title ?? page?.host ?? shotTitle(shot);
  const meta = [
    shot.kind === 'trace' ? shotTitle(shot) : null,
    page !== null && page.title !== null ? page.host : null,
    `${shot.width}×${shot.height}`,
    formatBytes(shot.size_bytes),
  ].filter((part) => part !== null);
  return (
    <div className="flex min-w-0 flex-col">
      <span className="flex items-baseline justify-between gap-2">
        <span className="truncate text-sm font-medium">{heading}</span>
        <span className="shrink-0 text-sm text-muted-foreground tabular-nums">
          {formatClock(shot.ts)}
        </span>
      </span>
      <span className="truncate text-xs text-muted-foreground tabular-nums">
        {meta.join(' · ')}
      </span>
    </div>
  );
}

/** @module features/templates/detail/SessionsTab — the Sessions tab (spec 13 §11.4): live and recent sessions launched from the template (BrowserHive's own sign-in and upkeep sessions marked "BrowserHive (system)"), each a whole-row link; the browser's Other windows with Close; windows that show pages of several sessions */
import type { SessionSummary, TemplateDetailResponse } from '@browserhive/contracts/http';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '@/app/providers/AuthProvider.tsx';
import { useTopic } from '@/app/providers/SocketProvider.tsx';
import { Chip } from '@/components/shared/Chip.tsx';
import { DataPanel } from '@/components/shared/DataPanel.tsx';
import { EmptyState } from '@/components/shared/EmptyState.tsx';
import { RelativeTime } from '@/components/shared/RelativeTime.tsx';
import { Panel } from '@/components/shared/Section.tsx';
import { SkeletonCard } from '@/components/shared/Skeletons.tsx';
import { StatusBadge } from '@/components/shared/StatusBadge.tsx';
import { UrlCell } from '@/components/shared/url-cell.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { keys } from '@/lib/api/keys.ts';
import { harnessLabel } from '@/lib/harness.ts';
import { ICONS } from '@/lib/icons.ts';
import { sessionDisplayState } from '@/lib/status-registry.ts';
import { LinkList, LinkRow } from '../../overview/components/LinkList.tsx';
import { useTemplateOperations } from '../api-operations.ts';

/** BrowserHive's own session of a template (recording, re-login, upkeep). */
export function isSystemSession(session: SessionSummary): boolean {
  return session.template?.mode === 'maintenance';
}

function SessionRow({ session }: { readonly session: SessionSummary }) {
  const system = isSystemSession(session);
  const Chevron = ICONS.chevronRight;
  return (
    <LinkRow
      href={`/sessions/${encodeURIComponent(session.session_id)}`}
      label={system ? `${session.slug}, BrowserHive (system) session` : `${session.slug}, session`}
      className="px-5 py-3"
    >
      <div className="flex min-w-0 items-center gap-x-4">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium decoration-muted-foreground/60 underline-offset-4 group-hover/row:underline">
              {session.slug}
            </span>
            {system ? <Chip tone="info">BrowserHive (system)</Chip> : null}
          </span>
          <span className="flex min-w-0 gap-1.5 text-sm text-muted-foreground">
            <span className="shrink-0">
              {system ? 'Sign-in and upkeep' : harnessLabel(session.harness)}
            </span>
            <span aria-hidden="true">·</span>
            <span className="truncate font-mono">{session.session_id}</span>
          </span>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-0.5 sm:flex-row sm:items-center sm:gap-4">
          <StatusBadge domain="session" value={sessionDisplayState(session)} />
          <RelativeTime at={session.created_at} className="text-sm text-muted-foreground" />
        </div>
        <Chevron aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      </div>
    </LinkRow>
  );
}

function OtherWindows({ detail }: { readonly detail: TemplateDetailResponse }) {
  const ops = useTemplateOperations(detail.template.template_id);
  const closing = ops.closeParkedPage.isPending ? ops.closeParkedPage.variables : undefined;
  return (
    <Panel
      title="Other windows"
      description="Tabs and windows of this browser that no session owns: ones you opened by hand, or that a site opened on its own. Agents can’t see them."
      padding="none"
    >
      {detail.parked_pages.length === 0 ? (
        <EmptyState kind="zero-data" size="sm" title="No other windows" />
      ) : (
        <ul aria-label="Other windows" className="flex flex-col divide-y">
          {detail.parked_pages.map((page) => (
            <li
              key={page.target_id}
              className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3"
            >
              <div className="flex min-w-0 flex-[1_1_14rem] flex-col">
                <span className="truncate">{page.title === '' ? 'Untitled' : page.title}</span>
                <UrlCell url={page.url} head={40} tail={16} className="text-sm" />
              </div>
              <span className="text-sm text-muted-foreground">
                opened <RelativeTime at={page.opened_at} className="min-w-0 text-sm" />
              </span>
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={closing !== undefined}
                aria-label={`Close ${page.title === '' ? page.url : page.title}`}
                onClick={() => ops.closeParkedPage.mutate(page.target_id)}
              >
                {closing === page.target_id ? <Spinner /> : null}
                Close
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** Sessions tab. */
export function SessionsTab({ detail }: { readonly detail: TemplateDetailResponse }) {
  const api = useApi();
  const id = detail.template.template_id;
  const query = {
    template: [id],
    maintenance: 'include',
    limit: 25,
    sort: 'created_at',
    dir: 'desc',
  } as const;
  const sessions = useQuery({
    queryKey: keys.sessions.list({ ...query, template: id }),
    queryFn: () => api.listSessions({ query: { ...query, template: [id] } }),
  });
  useTopic('sessions');
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Panel
        title="Sessions"
        description={`${detail.sessions_live} live · every session of this template shares its browser and sign-ins.`}
        padding="none"
      >
        <DataPanel
          query={sessions}
          skeleton={<SkeletonCard className="m-5" />}
          isEmpty={(page) => page.data.length === 0}
          empty={
            <EmptyState
              kind="zero-data"
              size="sm"
              title="No sessions yet"
              description="Agents start one with launch_session and this template’s name."
            />
          }
        >
          {(page) => (
            <LinkList label="Sessions of this template">
              {page.data.map((session) => (
                <SessionRow key={session.session_id} session={session} />
              ))}
            </LinkList>
          )}
        </DataPanel>
      </Panel>
      <OtherWindows detail={detail} />
      {detail.shared_windows.length > 0 ? (
        <Panel
          title="Shared windows"
          description="A site moved tabs of several sessions into one window. Each tab still belongs to its own session."
          padding="none"
        >
          <ul aria-label="Shared windows" className="flex flex-col divide-y">
            {detail.shared_windows.map((w) => (
              <li key={w.window_id} className="flex min-w-0 flex-wrap gap-x-3 px-5 py-3 text-sm">
                <span className="text-muted-foreground">Window {w.window_id}</span>
                <span className="min-w-0 font-mono [overflow-wrap:anywhere]">
                  {w.session_ids.join(', ')}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </div>
  );
}

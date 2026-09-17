/** @module features/sessions/detail/DetailsPanel — Details tab: a compact counts strip that links into Activity with filters, the session record (owner, client, browser, persistence, lease, lifetime, URL), identity & coherence, and "Resize the agent's browser" while live; zero-noise counts (vault fills only with the vault on) and a worded closed reason */
import type { SessionDetail, TimelineKind } from '@browserhive/contracts/http';
import { Link } from '@tanstack/react-router';
import { KeyValue, type KeyValueItem } from '@/components/shared/KeyValue.tsx';
import { LeaseBar } from '@/components/shared/lease-bar.tsx';
import { RelativeTime } from '@/components/shared/RelativeTime.tsx';
import { Panel } from '@/components/shared/Section.tsx';
import { StatusBadge } from '@/components/shared/StatusBadge.tsx';
import { UrlCell } from '@/components/shared/url-cell.tsx';
import { formatNumber } from '@/lib/format/bytes.ts';
import { formatDuration } from '@/lib/format/time.ts';
import { ICONS } from '@/lib/icons.ts';
import { useServerNow } from '@/lib/server-now.ts';
import { sessionDisplayState } from '@/lib/status-registry.ts';
import { cn } from '@/lib/utils.ts';
import { useSessionMutations, useVaultEnabled } from '../api.ts';
import { closedReasonNote } from '../session-format.ts';
import { IdentityCard } from './IdentityCard.tsx';
import { ViewportForm } from './ViewportForm.tsx';

/** One cell of the counts strip. */
interface CountLink {
  readonly label: string;
  readonly value: number;
  readonly tone?: 'danger' | 'warn';
  readonly search: { readonly kinds?: TimelineKind[]; readonly errors_only?: 1 };
}

function CountsStrip({
  detail,
  vaultEnabled,
}: {
  readonly detail: SessionDetail;
  readonly vaultEnabled: boolean;
}) {
  const { counts } = detail;
  const id = detail.session.session_id;
  // The core three always show (a zero is information there); the rest only when they happened,
  // and vault fills never while the vault is off.
  const all: readonly (CountLink & { readonly always?: boolean })[] = [
    { label: 'Tool calls', value: counts.tool_calls, search: { kinds: ['tool'] }, always: true },
    {
      label: 'Errors',
      value: counts.errors,
      tone: 'danger',
      search: { errors_only: 1 },
      always: true,
    },
    { label: 'Pages', value: counts.pages, search: { kinds: ['page'] }, always: true },
    { label: 'Blocked', value: counts.blocked, tone: 'danger', search: { kinds: ['blocked'] } },
    {
      label: 'Vault fills',
      value: counts.vault_access,
      search: { kinds: ['vault'] },
      always: vaultEnabled,
    },
    {
      label: 'Open attention',
      value: counts.attention_open,
      tone: 'warn',
      search: { kinds: ['attention'] },
    },
  ];
  const cells = all.filter((cell) => cell.always === true || cell.value > 0);
  const Arrow = ICONS.arrowUpRight;
  return (
    <nav
      aria-label="Session counts"
      className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] overflow-hidden rounded-xl border bg-card shadow-xs dark:shadow-none"
    >
      {cells.map((cell) => (
        <Link
          key={cell.label}
          to="/sessions/$id"
          params={{ id }}
          search={{ tab: 'activity', ...cell.search }}
          className="group/count relative -mt-px -ml-px flex flex-col gap-1 border-t border-l px-4 py-3 transition-colors duration-(--duration-fast) hover:bg-accent/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring dark:hover:bg-white/[0.03]"
        >
          <span className="flex items-center justify-between text-sm text-muted-foreground">
            {cell.label}
            <Arrow
              aria-hidden="true"
              className="size-3.5 opacity-0 transition-opacity group-hover/count:opacity-100 group-focus-visible/count:opacity-100"
            />
          </span>
          <span
            className={cn(
              'text-xl font-semibold tabular-nums',
              cell.value === 0 && 'text-muted-foreground',
              cell.value > 0 && cell.tone === 'danger' && 'text-danger-text',
              cell.value > 0 && cell.tone === 'warn' && 'text-warn-text',
            )}
          >
            {formatNumber(cell.value)}
          </span>
        </Link>
      ))}
    </nav>
  );
}

function SessionRecord({ detail }: { readonly detail: SessionDetail }) {
  const { session } = detail;
  const now = useServerNow();
  const items: KeyValueItem[] = [
    {
      key: 'State',
      value: (
        <span className="inline-flex flex-wrap items-center gap-2">
          <StatusBadge domain="session" value={sessionDisplayState(session)} />
          {session.closed_reason !== null ? (
            <span className="text-sm text-muted-foreground">
              {closedReasonNote(session.closed_reason)}
            </span>
          ) : null}
        </span>
      ),
    },
    { key: 'Owner', value: session.owner },
  ];
  if (session.client !== null) {
    const c = session.client;
    const parts = [c.name, c.version, c.agent_name, c.model].filter(
      (v): v is string => typeof v === 'string' && v !== '',
    );
    if (parts.length > 0) items.push({ key: 'Client', value: parts.join(' · ') });
  }
  items.push(
    {
      key: 'Browser',
      value: [
        session.channel,
        session.headless ? 'headless' : 'headed',
        session.incognito ? 'incognito' : null,
      ]
        .filter((v) => v !== null)
        .join(' · '),
    },
    { key: 'Persistence', value: session.persistence_mode },
    { key: 'Started', value: <RelativeTime at={session.created_at} mode="both" /> },
  );
  if (session.closed_at !== null) {
    items.push(
      { key: 'Closed', value: <RelativeTime at={session.closed_at} mode="both" /> },
      { key: 'Lifetime', value: formatDuration(session.closed_at - session.created_at) },
    );
  } else {
    items.push({
      key: 'Lease',
      value: (
        <LeaseBar
          remainingMs={session.lease_expires_at - now}
          pausedAt={session.lease_paused_at}
          className="max-w-64"
        />
      ),
    });
  }
  items.push({ key: 'Last URL', value: <UrlCell url={session.current_url} head={40} tail={20} /> });
  if (session.proxy_label !== null) items.push({ key: 'Proxy', value: session.proxy_label });
  return (
    <Panel title="Session">
      <KeyValue items={items} />
    </Panel>
  );
}

/** Details tab. */
export function DetailsPanel({ detail }: { readonly detail: SessionDetail }) {
  const { session } = detail;
  const { setViewport } = useSessionMutations(session.session_id);
  const vaultEnabled = useVaultEnabled() === true;
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <CountsStrip detail={detail} vaultEnabled={vaultEnabled} />
      <div className="grid min-w-0 gap-5 xl:grid-cols-2">
        <SessionRecord detail={detail} />
        <Panel
          title="Identity & coherence"
          info={
            <>
              <p>
                What this browser presents to websites. With stealth on, the user agent, client
                hints, locale and timezone are derived from this machine so they agree with each
                other.
              </p>
              <p>Stealth is scoped honestly: the guide lists what it does not hide.</p>
            </>
          }
          infoDocs="stealth"
        >
          <IdentityCard session={session} />
        </Panel>
      </div>
      {session.live ? (
        <Panel
          title="Browser viewport"
          description="Resize the page the agent is driving, for example to reach a mobile layout."
          className="max-w-2xl"
        >
          <ViewportForm
            busy={setViewport.isPending}
            screen={
              typeof window === 'undefined'
                ? undefined
                : { width: window.screen.width, height: window.screen.height }
            }
            onSubmit={(size) => setViewport.mutate(size)}
          />
          {setViewport.data !== undefined ? (
            <p role="status" className="mt-3 text-sm text-muted-foreground">
              Viewport set to {setViewport.data.width}×{setViewport.data.height}
              {setViewport.data.clamped === true ? ' (clamped by the driver)' : ''}.
            </p>
          ) : null}
        </Panel>
      ) : null}
    </div>
  );
}

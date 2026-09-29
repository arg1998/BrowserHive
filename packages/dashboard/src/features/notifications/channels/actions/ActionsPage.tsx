/** @module features/notifications/channels/actions/ActionsPage — `/notifications/actions`: the audit of act-button presses newest first (time, channel, the notification and its button, who pressed, the outcome with its sentence; "Allow this person" on a press refused by the allow-list), filters in the URL, live through the `channels` topic; a row opens the delivery log of its notification (spec 04 §12.11.1, D-41) */
import type { ActionRow, ChannelView } from '@browserhive/contracts/http';
import { ACTION_OUTCOME_TEXT } from '@browserhive/contracts/notifications';
import { Link } from '@tanstack/react-router';
import { useConfirm } from '@/app/providers/ConfirmProvider.tsx';
import { useTopic } from '@/app/providers/SocketProvider.tsx';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { DataPanel } from '@/components/shared/DataPanel.tsx';
import { EmptyState } from '@/components/shared/EmptyState.tsx';
import { FilterBar } from '@/components/shared/FilterBar.tsx';
import { PageHeader } from '@/components/shared/PageHeader.tsx';
import { Pagination } from '@/components/shared/Pagination.tsx';
import { RelativeTime } from '@/components/shared/RelativeTime.tsx';
import { Panel } from '@/components/shared/Section.tsx';
import { TonePill } from '@/components/shared/StatusBadge.tsx';
import { Button, buttonVariants } from '@/components/ui/button.tsx';
import { ListSkeleton } from '@/features/overview/components/ListSkeleton.tsx';
import { toAppError } from '@/lib/api/errors.ts';
import { ICONS } from '@/lib/icons.ts';
import { useSearchState } from '@/lib/search/use-search-state.ts';
import { ACTION_OUTCOME } from '@/lib/status-registry.ts';
import { cn } from '@/lib/utils.ts';
import { NotificationsNav } from '../../NotificationsNav.tsx';
import { useActionAudit, useAllowPresser, useChannels } from '../api.ts';
import { PlatformMark } from '../platforms.tsx';
import type { ActionsSearch } from '../search.ts';

const OUTCOMES = [
  'done',
  'failed',
  'not_allowed',
  'used',
  'expired',
  'stale',
  'wrong_channel',
  'disabled',
] as const;

const OP_LABEL: Readonly<Record<string, string>> = {
  'attention.resolve': 'attention request',
  'vault.confirm.resolve': 'vault fill',
  'session.close': 'session',
  'session.extend_lease': 'session lease',
};

const PLATFORM_LABEL: Readonly<Record<string, string>> = {
  telegram: 'Telegram',
  discord: 'Discord',
  ntfy: 'ntfy',
};

/** Who pressed, as a name and a coordinate ("Telegram · 123456789", "ntfy reply topic"). */
export function actorParts(row: Pick<ActionRow, 'actor' | 'actor_name'>): {
  readonly name: string;
  readonly platform: string;
  readonly id: string | null;
} {
  const colon = row.actor.indexOf(':');
  const platform = colon < 0 ? row.actor : row.actor.slice(0, colon);
  const id = colon < 0 ? null : row.actor.slice(colon + 1);
  const label = PLATFORM_LABEL[platform] ?? platform;
  if (platform === 'ntfy') {
    return {
      name: row.actor_name ?? 'Someone with the topic',
      platform: 'ntfy reply topic',
      id: null,
    };
  }
  return { name: row.actor_name ?? `${label} user`, platform: label, id };
}

/** The id a refused presser can be allowed with (`telegram:<id>`, `discord:<id>`), or `null`. */
export function allowableId(row: Pick<ActionRow, 'actor' | 'outcome'>): string | null {
  if (row.outcome !== 'not_allowed') return null;
  return /^(?:telegram|discord):(\d{1,21})$/.exec(row.actor)?.[1] ?? null;
}

/** "Allow this person" on a refused press (D-41): adds the presser's id to the channel's allow-list. */
function AllowButton({
  row,
  channel,
}: {
  readonly row: ActionRow;
  readonly channel: ChannelView | undefined;
}) {
  const id = allowableId(row);
  const confirm = useConfirm();
  const toast = useToast();
  const allow = useAllowPresser();
  if (id === null || channel === undefined) return null;
  const who = row.actor_name ?? id;
  const Check = ICONS.check;
  const UserCheck = ICONS.allowList;
  if ((channel.rules.allow_list ?? []).includes(id)) {
    return (
      <span className="relative z-10 inline-flex items-center gap-1 text-xs font-medium text-success-text">
        <Check aria-hidden="true" className="size-3.5" />
        Allowed now
      </span>
    );
  }
  const startup = channel.source === 'startup';
  const onClick = async () => {
    const ok = await confirm({
      title: `Allow ${who} to answer on ${channel.name}?`,
      description: `${who} (${id}) is added to the channel's allowed people and can then press Approve, Reject and Mark resolved in the chat. You can remove them in Channels → ${channel.name} → Answer from the chat.`,
      confirmLabel: 'Allow this person',
    });
    if (!ok) return;
    allow.mutate(
      { channelId: channel.channel_id, userId: id },
      {
        onSuccess: () =>
          toast.success({
            title: `${who} can now answer on ${channel.name}`,
            description: 'Added to the allowed people. Their next press works.',
          }),
        onError: (error) => toast.fromError(toAppError(error), 'Could not add them'),
      },
    );
  };
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="relative z-10 h-7 w-fit"
      disabled={startup || allow.isPending}
      title={
        startup
          ? `${channel.name} comes from --notificationChannel: add allow=${id} to its flag and restart.`
          : undefined
      }
      onClick={() => void onClick()}
    >
      <UserCheck aria-hidden="true" />
      Allow this person
    </Button>
  );
}

function Row({
  row,
  channel,
}: {
  readonly row: ActionRow;
  readonly channel: ChannelView | undefined;
}) {
  const entry = ACTION_OUTCOME[row.outcome];
  const who = actorParts(row);
  const Chevron = ICONS.chevronRight;
  const sentence =
    row.outcome === 'not_allowed'
      ? 'Refused: not on the allow-list.'
      : (row.detail ?? ACTION_OUTCOME_TEXT[row.outcome] ?? null);
  const linked = row.notification_id !== null;
  return (
    <li
      className={cn(
        'group/row relative transition-colors',
        linked &&
          'hover:bg-accent/70 has-[a:focus-visible]:bg-accent/70 dark:hover:bg-white/[0.035]',
      )}
    >
      {linked ? (
        <Link
          to="/notifications/log"
          search={{ notification: row.notification_id ?? undefined }}
          className="absolute inset-0 focus-ring-inset"
        >
          <span className="sr-only">
            {row.action_label ?? row.action_id} on {row.notification_title ?? 'a notification'},{' '}
            {entry.label}: open its deliveries
          </span>
        </Link>
      ) : null}
      <div className="pointer-events-none grid w-full grid-cols-[1fr_auto] gap-x-4 gap-y-1 px-4 py-3 text-left lg:grid-cols-[7rem_minmax(8rem,11rem)_minmax(0,1fr)_minmax(9rem,13rem)_minmax(10rem,16rem)_1rem] lg:items-center [&_button]:pointer-events-auto">
        <span className="order-4 col-span-2 text-xs text-muted-foreground lg:order-none lg:col-span-1 lg:text-sm">
          <RelativeTime at={row.at} />
        </span>
        <span className="order-1 flex min-w-0 items-center gap-2 lg:order-none">
          <PlatformMark kind={row.channel_kind} size="sm" />
          <span className="truncate text-sm font-medium">{row.channel_name}</span>
        </span>
        <span className="order-3 col-span-2 flex min-w-0 flex-col lg:order-none lg:col-span-1">
          <span className={cn('truncate text-sm', linked && 'group-hover/row:underline')}>
            {row.notification_title ?? 'A notification that is gone'}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            Pressed{' '}
            <span className="font-medium text-foreground">{row.action_label ?? row.action_id}</span>
            {' · '}
            {OP_LABEL[row.op] ?? row.op}
          </span>
        </span>
        <span className="order-5 col-span-2 flex min-w-0 flex-col lg:order-none lg:col-span-1">
          <span className="truncate text-sm">{who.name}</span>
          <span className="truncate text-xs text-muted-foreground">
            {who.platform}
            {who.id !== null ? (
              <>
                {' · '}
                <span className="font-mono">{who.id}</span>
              </>
            ) : null}
          </span>
        </span>
        <span className="order-2 flex min-w-0 flex-col items-end gap-1 lg:order-none lg:items-start">
          <TonePill entry={entry} />
          {sentence !== null ? (
            <span
              className={cn(
                'line-clamp-2 text-right text-xs text-muted-foreground lg:block lg:text-left',
                row.outcome !== 'not_allowed' && 'hidden',
              )}
              title={sentence}
            >
              {sentence}
            </span>
          ) : null}
          <AllowButton row={row} channel={channel} />
        </span>
        {linked ? (
          <Chevron
            aria-hidden="true"
            className="order-6 hidden size-4 text-subtle-foreground lg:block"
          />
        ) : (
          <span aria-hidden="true" className="hidden lg:block" />
        )}
      </div>
    </li>
  );
}

/** Notifications › Actions. */
export function ActionsPage() {
  const { search, set, clear } = useSearchState<ActionsSearch>();
  const channels = useChannels();
  const list = useActionAudit(
    { channel: search.channel, outcome: search.outcome },
    search.page,
    search.ps,
  );
  useTopic('channels');
  const filtered = search.channel !== undefined || search.outcome !== undefined;
  const Settings = ICONS.channels;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Notifications"
        description="Every button pressed in a chat: who answered which request, and what happened."
        learnMore="With “Answer from the chat” on, Approve, Reject and Mark resolved work right in Telegram, a Discord bot or ntfy. Each press is checked (the right chat, a person on the channel's allow-list, a request that still waits, a button used once) and recorded here, whether it ran or was refused."
        learnMoreDocs="notificationChannels"
        tabs={<NotificationsNav />}
      />
      <FilterBar
        selects={[
          {
            param: 'channel',
            label: 'Channel',
            value: search.channel,
            allLabel: 'All channels',
            options: (channels.data?.data ?? []).map((c) => ({
              value: c.channel_id,
              label: c.name,
            })),
          },
        ]}
        chips={[
          {
            param: 'outcome',
            label: 'Outcome',
            options: OUTCOMES.map((value) => ({ value, count: 0 })),
            selected: search.outcome ?? [],
            counts: false,
            format: (v) => ACTION_OUTCOME[v as keyof typeof ACTION_OUTCOME]?.label ?? v,
          },
        ]}
        {...(list.data?.page.total !== undefined && { matching: list.data.page.total })}
        onChange={(param, value) => set({ [param]: value })}
        onClear={() => clear()}
      />
      <DataPanel
        query={list}
        skeleton={
          <Panel padding="none">
            <ListSkeleton rows={8} twoLine />
          </Panel>
        }
        isEmpty={(page) => page.data.length === 0}
        empty={
          filtered ? (
            <EmptyState
              kind="zero-results"
              variant="panel"
              icon="actions"
              title="No presses match"
              description="Try other filters."
              onClear={() => clear()}
            />
          ) : (
            <EmptyState
              kind="zero-data"
              variant="panel"
              icon="actions"
              title="No answers from a chat yet"
              description="Switch on “Answer from the chat” for a Telegram channel, a Discord bot or an ntfy channel with a reply topic (open the channel, then What to send). Approve, Reject and Mark resolved then work from your phone, and every press shows up here."
              action={
                <Link
                  to="/notifications/channels"
                  className={buttonVariants({ variant: 'outline', size: 'sm' })}
                >
                  <Settings aria-hidden="true" />
                  Go to channels
                </Link>
              }
            />
          )
        }
      >
        {(page) => (
          <div className="flex flex-col gap-4">
            <Panel padding="none" bodyClassName="overflow-hidden rounded-xl">
              <div
                aria-hidden="true"
                className="hidden grid-cols-[7rem_minmax(8rem,11rem)_minmax(0,1fr)_minmax(9rem,13rem)_minmax(10rem,16rem)_1rem] gap-x-4 border-b bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground lg:grid dark:bg-white/[0.02]"
              >
                <span>When</span>
                <span>Channel</span>
                <span>Button</span>
                <span>Pressed by</span>
                <span>Outcome</span>
                <span />
              </div>
              <ul aria-label="Button presses" className="flex flex-col divide-y divide-border">
                {page.data.map((row) => (
                  <Row
                    key={row.seq}
                    row={row}
                    channel={channels.data?.data.find((c) => c.channel_id === row.channel_id)}
                  />
                ))}
              </ul>
            </Panel>
            <Pagination
              page={search.page}
              pageSize={search.ps}
              {...(page.page.total !== undefined && { total: page.page.total })}
              hasNext={page.page.next_cursor !== null}
              onPage={(p) => set({ page: p })}
              onPageSize={(ps) => set({ ps })}
            />
          </div>
        )}
      </DataPanel>
    </div>
  );
}

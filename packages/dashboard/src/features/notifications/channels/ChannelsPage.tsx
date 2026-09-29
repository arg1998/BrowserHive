/** @module features/notifications/channels/ChannelsPage — `/notifications/channels`: every notification channel as a card (live through the `channels` topic), Add channel, the public-address hint when links would only open on this computer, and an empty state that explains channels (spec 04 §12.11.1) */
import type { ChannelView } from '@browserhive/contracts/http';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useConfirm } from '@/app/providers/ConfirmProvider.tsx';
import { useTopic } from '@/app/providers/SocketProvider.tsx';
import { Callout } from '@/components/shared/Callout.tsx';
import { DataPanel } from '@/components/shared/DataPanel.tsx';
import { PageHeader } from '@/components/shared/PageHeader.tsx';
import { buttonVariants } from '@/components/ui/button.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { usePublicUrl } from '@/features/system/api.ts';
import { toAppError } from '@/lib/api/errors.ts';
import { ICONS } from '@/lib/icons.ts';
import { docsUrl } from '@/lib/links.ts';
import { useServerNow } from '@/lib/server-now.ts';
import { cn } from '@/lib/utils.ts';
import { NotificationsNav } from '../NotificationsNav.tsx';
import { useChannelActions, useChannels, useTestChannel } from './api.ts';
import { ChannelCard, type TestState } from './ChannelCard.tsx';
import { PLATFORMS, PlatformMark } from './platforms.tsx';

/** The channels, sorted: dashboard channels and startup channels by name. */
export function sortChannels(rows: readonly ChannelView[]): readonly ChannelView[] {
  return [...rows].sort((a, b) => a.name.localeCompare(b.name));
}

function EmptyChannels() {
  const Plus = ICONS.plus;
  return (
    <div className="flex flex-col items-center gap-5 rounded-xl border bg-card px-6 py-12 text-center shadow-xs dark:shadow-none">
      <div className="flex items-center -space-x-1.5">
        {PLATFORMS.map((p) => (
          <PlatformMark key={p.kind} kind={p.kind} size="lg" className="ring-4 ring-card" />
        ))}
      </div>
      <div className="flex max-w-md flex-col gap-1.5">
        <h2 className="text-lg font-semibold">Get notified on your phone</h2>
        <p className="text-base text-muted-foreground">
          When an agent needs you, a session crashes or tools keep failing, BrowserHive can message
          you on Telegram, Discord or ntfy, or post to your own webhook. Messages update as things
          change and can delete themselves later. You bring your own bot or topic; nothing goes
          through a BrowserHive server.
        </p>
      </div>
      <Link to="/notifications/channels/new" className={buttonVariants({ variant: 'default' })}>
        <Plus aria-hidden="true" />
        Add a channel
      </Link>
    </div>
  );
}

function CardsSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 wide:grid-cols-3" aria-busy="true">
      {[0, 1, 2].map((n) => (
        <div key={n} className="flex flex-col gap-4 rounded-xl border bg-card p-5">
          <div className="flex items-center gap-3">
            <Skeleton className="size-9 rounded-lg" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-3 w-40" />
            </div>
          </div>
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="h-14 w-full rounded-lg" />
          <Skeleton className="h-8 w-40" />
        </div>
      ))}
    </div>
  );
}

/** Notifications › Channels. */
export function ChannelsPage() {
  const channels = useChannels();
  const publicUrl = usePublicUrl();
  const actions = useChannelActions();
  const testChannel = useTestChannel();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const now = useServerNow(30_000);
  const [tests, setTests] = useState<Readonly<Record<string, TestState>>>({});
  useTopic('channels');
  const Plus = ICONS.plus;

  const runTest = (id: string) => {
    setTests((t) => ({ ...t, [id]: { phase: 'sending' } }));
    testChannel.mutate(id, {
      onSuccess: (result) => setTests((t) => ({ ...t, [id]: { phase: 'done', result } })),
      onError: (error) =>
        setTests((t) => ({ ...t, [id]: { phase: 'error', message: toAppError(error).message } })),
    });
  };

  const remove = async (channel: ChannelView) => {
    const ok = await confirm({
      title: `Delete ${channel.name}?`,
      description:
        'BrowserHive stops sending to it, and its delivery log goes with it. Messages already sent stay in the chat.',
      confirmLabel: 'Delete channel',
      danger: true,
    });
    if (ok) actions.remove.mutate(channel.channel_id);
  };

  const unsetPublicUrl = publicUrl.data !== undefined && !publicUrl.data.configured;
  const hasChannels = (channels.data?.data.length ?? 0) > 0;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Notifications"
        description="Where BrowserHive reaches you when it needs you: your phone, your team chat, your own tools."
        learnMore="Each channel gets its own copy of every notification its rules allow. Secrets never enter the database: a channel stores the names of environment variables, and BrowserHive reads them when it starts."
        learnMoreDocs="notificationChannels"
        actions={
          hasChannels ? (
            <Link
              to="/notifications/channels/new"
              className={buttonVariants({ variant: 'default', size: 'sm' })}
            >
              <Plus aria-hidden="true" />
              Add channel
            </Link>
          ) : undefined
        }
        tabs={<NotificationsNav />}
      />
      {unsetPublicUrl && hasChannels ? (
        <Callout
          tone="info"
          title="Links in notifications open on this computer only"
          dismissible={{ key: 'channels.public-url' }}
          action={
            <a
              href={docsUrl('publicAddress')}
              target="_blank"
              rel="noreferrer"
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              How to set publicUrl
            </a>
          }
        >
          Set <code className="font-mono">publicUrl</code> to the address where you reach this
          dashboard (a reverse proxy, a tunnel or a Tailscale name) so "Open session" works from
          your phone.
        </Callout>
      ) : null}
      <DataPanel
        query={channels}
        skeleton={<CardsSkeleton />}
        isEmpty={(data) => data.data.length === 0}
        empty={<EmptyChannels />}
      >
        {(data) => (
          <ul
            aria-label="Notification channels"
            className="grid grid-cols-1 gap-4 lg:grid-cols-2 wide:grid-cols-3"
          >
            {sortChannels(data.data).map((channel) => {
              const href = `/notifications/channels/${encodeURIComponent(channel.channel_id)}`;
              return (
                <li key={channel.channel_id} className={cn('flex min-w-0')}>
                  <ChannelCard
                    channel={channel}
                    now={now}
                    href={href}
                    test={tests[channel.channel_id] ?? { phase: 'idle' }}
                    busy={actions.pause.isPending || actions.resume.isPending}
                    onTest={() => runTest(channel.channel_id)}
                    onPause={() => actions.pause.mutate(channel.channel_id)}
                    onResume={() => actions.resume.mutate(channel.channel_id)}
                    onEdit={() =>
                      void navigate({
                        to: '/notifications/channels/$channelId',
                        params: { channelId: channel.channel_id },
                      })
                    }
                    onDuplicate={() =>
                      void navigate({
                        to: '/notifications/channels/new',
                        search: { from: channel.channel_id, step: 'rules' },
                      })
                    }
                    onDelete={() => void remove(channel)}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </DataPanel>
    </div>
  );
}

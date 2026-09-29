/** @module features/notifications/channels/ChannelCard — one channel as a whole-card link: platform mark, name, status, where it sends, what it sends, whether answers from the chat reach BrowserHive (the press listener's state, D-41), secret variables (set / missing, never values), last delivery and 24 h counts; Send test (result inline), Pause/Resume, and Edit / Duplicate / Delete in a menu (not for startup channels, which are read-only; D-39) */
import type { ChannelTestResponse, ChannelView } from '@browserhive/contracts/http';
import { deliveryReasonText } from '@browserhive/contracts/notifications';
import { isPlainClick, useHrefNavigate } from '@/components/shared/DataTableBody.tsx';
import { RelativeTime } from '@/components/shared/RelativeTime.tsx';
import { StatusDot, TonePill } from '@/components/shared/StatusBadge.tsx';
import { Button } from '@/components/ui/button.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { formatNumber } from '@/lib/format/bytes.ts';
import { formatMs } from '@/lib/format/time.ts';
import { ICONS } from '@/lib/icons.ts';
import { CHANNEL_STATUS, DELIVERY_STATUS, LISTENER_STATE } from '@/lib/status-registry.ts';
import { cn } from '@/lib/utils.ts';
import { channelWhere, rulesSummary } from './model.ts';
import { PlatformMark, platformOf } from './platforms.tsx';

/** The outcome of the last test send of a card. */
export type TestState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'sending' }
  | { readonly phase: 'done'; readonly result: ChannelTestResponse }
  | { readonly phase: 'error'; readonly message: string };

/** Props. */
export interface ChannelCardProps {
  readonly channel: ChannelView;
  readonly now: number;
  readonly href: string;
  readonly test: TestState;
  readonly onTest: () => void;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onDuplicate: () => void;
  readonly onDelete: () => void;
  readonly onEdit: () => void;
  readonly busy?: boolean;
}

/** "Answers from the chat": whether presses reach BrowserHive (only with act buttons on). */
function AnswersLine({ channel, now }: { readonly channel: ChannelView; readonly now: number }) {
  if (channel.rules.act_buttons !== true) return null;
  const Answer = ICONS.answer;
  const c = channel.connection;
  const allow = channel.rules.allow_list?.length ?? 0;
  const who =
    channel.kind === 'telegram' || channel.kind === 'discord'
      ? allow === 0
        ? 'no allowed people yet'
        : `${allow} ${allow === 1 ? 'person' : 'people'} may answer`
      : null;
  return (
    <div
      className={cn(
        'flex min-w-0 items-start gap-2 rounded-md px-3 py-2 text-sm',
        c?.state === 'offline'
          ? 'bg-danger-bg text-danger-text'
          : c?.state === 'connected' || channel.kind === 'webhook'
            ? 'bg-muted/60 dark:bg-white/[0.03]'
            : 'bg-warn-bg text-warn-text',
      )}
    >
      <Answer aria-hidden="true" className="mt-0.5 size-4 shrink-0 opacity-80" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="font-medium">Answers from the chat</span>
          {c !== null ? (
            <>
              <StatusDot entry={LISTENER_STATE[c.state]} />
              {c.state !== 'connected' ? (
                <span className="text-xs opacity-80">
                  since <RelativeTime at={c.since} now={now} />
                </span>
              ) : null}
            </>
          ) : (
            <span className="text-muted-foreground">
              {channel.kind === 'webhook' ? 'via your receiver' : 'not listening'}
            </span>
          )}
        </p>
        {c !== null && c.detail !== null && c.state !== 'connected' ? (
          <p className="text-xs [overflow-wrap:anywhere]">{c.detail}</p>
        ) : who !== null ? (
          <p className={cn('text-xs', allow === 0 ? 'text-warn-text' : 'text-muted-foreground')}>
            {who}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function TestResult({ test }: { readonly test: TestState }) {
  if (test.phase === 'idle') return null;
  if (test.phase === 'sending') {
    return (
      <span
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground"
        role="status"
      >
        <Spinner className="size-3.5" /> Sending a test…
      </span>
    );
  }
  if (test.phase === 'error') {
    return (
      <span className="text-sm text-danger-text [overflow-wrap:anywhere]" role="status">
        {test.message}
      </span>
    );
  }
  const { result } = test;
  const Ok = ICONS.success;
  if (result.ok) {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-success-text" role="status">
        <Ok aria-hidden="true" className="size-4" />
        Test sent
        {result.delivery?.duration_ms !== null && result.delivery?.duration_ms !== undefined
          ? ` · ${formatMs(result.delivery.duration_ms)}`
          : ''}
      </span>
    );
  }
  const code = result.error?.code ?? result.delivery?.reason ?? 'failed';
  return (
    <span className="text-sm text-danger-text [overflow-wrap:anywhere]" role="status">
      Test failed: {deliveryReasonText(code) ?? code}
      {result.error?.message !== undefined ? (
        <span className="block text-xs text-muted-foreground">{result.error.message}</span>
      ) : null}
    </span>
  );
}

/** One channel card. */
export function ChannelCard({
  channel,
  now,
  href,
  test,
  onTest,
  onPause,
  onResume,
  onDuplicate,
  onDelete,
  onEdit,
  busy = false,
}: ChannelCardProps) {
  const go = useHrefNavigate();
  const info = platformOf(channel.kind);
  const startup = channel.source === 'startup';
  const status = CHANNEL_STATUS[channel.status];
  const summary = rulesSummary(channel.rules);
  const stats = channel.stats;
  const More = ICONS.more;
  const Send = ICONS.sendTest;
  const Pause = ICONS.pause;
  const Play = ICONS.play;
  const Edit = ICONS.edit;
  const Duplicate = ICONS.duplicate;
  const Delete = ICONS.delete;
  const Check = ICONS.check;
  const Missing = ICONS.close;
  const Lock = ICONS.lock;
  const Warn = ICONS.warn;
  const Info = ICONS.info;
  return (
    <article
      data-row-link-scope=""
      aria-labelledby={`channel-${channel.channel_id}`}
      className={cn(
        'group/card relative flex w-full min-w-0 flex-col rounded-xl border bg-card text-card-foreground shadow-xs transition-[border-color,box-shadow] duration-(--duration-fast) hover:border-border-strong hover:shadow-sm has-[[data-row-link]:focus-visible]:border-ring dark:shadow-none',
        channel.status === 'broken' && 'border-danger-border hover:border-danger-border',
      )}
    >
      <a
        href={href}
        data-row-link=""
        className="absolute inset-0 rounded-[inherit] focus-ring"
        onClick={(event) => {
          if (!isPlainClick(event)) return;
          event.preventDefault();
          go(href);
        }}
      >
        <span className="sr-only">Open channel {channel.name}</span>
      </a>
      <div className="flex items-start gap-3 px-5 pt-5">
        <PlatformMark kind={channel.kind} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <h2
              id={`channel-${channel.channel_id}`}
              className="min-w-0 truncate text-md font-semibold group-hover/card:underline group-hover/card:underline-offset-4"
            >
              {channel.name}
            </h2>
            {startup ? (
              <TonePill
                entry={{
                  label: 'from startup',
                  tone: 'info',
                  icon: 'lock',
                  hint: 'Declared with --notificationChannel: change the flag and restart to edit it. Pausing works here.',
                }}
              />
            ) : null}
          </div>
          <p className="truncate text-sm text-muted-foreground">
            {info.label}
            {channel.mode !== null && channel.kind === 'discord'
              ? channel.mode === 'bot'
                ? ' bot'
                : ' webhook'
              : ''}
            {' · '}
            {channelWhere(channel)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <StatusDot entry={status} className="text-sm" />
          {!startup ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`More actions for ${channel.name}`}
                    className="-mr-2"
                  />
                }
              >
                <More aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem onClick={onEdit}>
                  <Edit aria-hidden="true" /> Edit
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onDuplicate}>
                  <Duplicate aria-hidden="true" /> Duplicate
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={onDelete}>
                  <Delete aria-hidden="true" /> Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <Lock aria-hidden="true" className="ml-1 size-4 text-subtle-foreground" />
          )}
        </div>
      </div>

      <div className="flex flex-col gap-3 px-5 pt-3 pb-4">
        <p className="line-clamp-2 min-h-5 text-sm">
          {summary === '' ? (
            <span className="text-muted-foreground">Every notification</span>
          ) : (
            summary
          )}
        </p>
        {channel.status === 'broken' && channel.last_error !== null ? (
          <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger-text [overflow-wrap:anywhere]">
            <span className="font-medium">Paused after {channel.failure_count} failures.</span>{' '}
            {channel.last_error}
          </p>
        ) : channel.problem !== null ? (
          <p
            className={cn(
              'flex gap-2 rounded-md px-3 py-2 text-sm [overflow-wrap:anywhere]',
              channel.ready
                ? 'bg-muted text-muted-foreground dark:bg-white/[0.05]'
                : 'bg-warn-bg text-warn-text',
            )}
          >
            {channel.ready ? (
              <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            ) : (
              <Warn aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            )}
            {channel.problem}
          </p>
        ) : null}
        <AnswersLine channel={channel} now={now} />
        <ul aria-label="Environment variables" className="flex flex-wrap gap-1.5">
          {channel.secrets.map((s) => (
            <li
              key={s.param}
              className={cn(
                'inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-xs',
                s.set
                  ? 'border-border text-muted-foreground'
                  : 'border-danger-border bg-danger-bg text-danger-text',
              )}
            >
              {s.set ? (
                <Check aria-hidden="true" className="size-3 text-success-text" />
              ) : (
                <Missing aria-hidden="true" className="size-3" />
              )}
              <span className="truncate">{s.env}</span>
              <span className="sr-only">{s.set ? 'is set' : 'is missing'}</span>
            </li>
          ))}
        </ul>
        <dl className="grid grid-cols-3 gap-2 rounded-lg bg-muted/60 px-3 py-2.5 dark:bg-white/[0.03]">
          <div className="flex flex-col">
            <dt className="text-xs text-muted-foreground">Sent · 24 h</dt>
            <dd className="text-md font-semibold tabular-nums">{formatNumber(stats.sent_24h)}</dd>
          </div>
          <div className="flex flex-col">
            <dt className="text-xs text-muted-foreground">Failed</dt>
            <dd
              className={cn(
                'text-md font-semibold tabular-nums',
                stats.failed_24h > 0 && 'text-danger-text',
              )}
            >
              {formatNumber(stats.failed_24h)}
            </dd>
          </div>
          <div className="flex flex-col">
            <dt className="text-xs text-muted-foreground">Not sent</dt>
            <dd className="text-md font-semibold tabular-nums">
              {formatNumber(stats.suppressed_24h)}
            </dd>
          </div>
        </dl>
        <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-sm text-muted-foreground">
          {stats.last_delivery_at !== null && stats.last_status !== null ? (
            <>
              <span>Last delivery</span>
              <span className="text-foreground">{DELIVERY_STATUS[stats.last_status].label}</span>
              <RelativeTime at={stats.last_delivery_at} now={now} />
            </>
          ) : (
            <span>Nothing sent yet</span>
          )}
          {stats.pending > 0 ? <span>· {formatNumber(stats.pending)} waiting</span> : null}
        </p>
      </div>

      <div className="mt-auto flex flex-wrap items-center gap-2 border-t px-5 py-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={test.phase === 'sending' || !channel.ready || channel.status === 'paused'}
          onClick={onTest}
        >
          <Send aria-hidden="true" />
          Send test
        </Button>
        {channel.status === 'active' ? (
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onPause}>
            <Pause aria-hidden="true" />
            Pause
          </Button>
        ) : (
          <Button
            type="button"
            variant={channel.status === 'broken' ? 'default' : 'ghost'}
            size="sm"
            disabled={busy}
            onClick={onResume}
          >
            <Play aria-hidden="true" />
            {channel.status === 'broken' ? 'Resume and retry' : 'Resume'}
          </Button>
        )}
        <div className="min-w-0 basis-full sm:basis-auto sm:flex-1 sm:text-right">
          <TestResult test={test} />
        </div>
      </div>
    </article>
  );
}

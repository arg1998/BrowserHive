/** @module features/attention/AttentionCard — one open request, built for a fast decision: mode (and "Site check" / "Write approval" for a site pack's `security_intercept`) + waiting time + deadline on the meta line, the reason as a wrapping headline, session/page/options facts (an intercept's site, guard, method and URL as text), the latest screenshot when one exists, an optional message and the actions (Take over primary for takeover requests, Resolve secondary, Reject quiet; Approve and Deny for a write approval) (spec 04 §12.4) */
import type { OperatorRequestRow } from '@browserhive/contracts/http';
import { memo, useId } from 'react';
import { isPlainClick, useHrefNavigate } from '@/components/shared/DataTableBody.tsx';
import { TonePill } from '@/components/shared/StatusBadge.tsx';
import { SessionRef } from '@/components/shared/session-ref.tsx';
import { UrlCell } from '@/components/shared/url-cell.tsx';
import { Button, buttonVariants } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { ICONS } from '@/lib/icons.ts';
import type { StatusEntry } from '@/lib/status-registry.ts';
import { cn } from '@/lib/utils.ts';
import { AgentOptions, hasOptions, Reason } from './card-parts.tsx';
import { RequestThumbnail } from './RequestThumbnail.tsx';
import {
  InterceptFacts,
  interceptBadge,
  interceptOf,
  onlyDecidedHere,
} from './SecurityIntercept.tsx';
import { sessionHref } from './session-link.ts';
import { DeadlinePill, WaitingFor } from './Tickers.tsx';

export { choicesOf } from './card-parts.tsx';

/** Settle decision. */
export type Decision = 'resolve' | 'reject';

/** Props. */
export interface AttentionCardProps {
  readonly item: OperatorRequestRow;
  readonly message: string;
  /** Stable across renders (keyed by request id) so ticking or typing elsewhere never re-renders this card. */
  readonly onMessage: (requestId: string, value: string) => void;
  readonly onSettle: (item: OperatorRequestRow, decision: Decision) => void;
  readonly busy?: boolean;
}

/** Mode badge entries. */
export const MODE_BADGE: { readonly takeover: StatusEntry; readonly notify: StatusEntry } = {
  takeover: {
    label: 'Take over',
    tone: 'warn',
    icon: 'takeover',
    hint: 'The agent hit something only a human can clear. Drive the browser, then Resolve.',
  },
  notify: {
    label: 'Notify',
    tone: 'info',
    icon: 'notifications',
    hint: 'The agent paused to flag something. Resolving lets it carry on.',
  },
};

/** Takeover deep link: the session workspace with the live pane open and input armed. */
export function takeoverHref(sessionId: string): string {
  return `${sessionHref(sessionId)}?live=1&takeover=1`;
}

/** Attention card. */
export const AttentionCard = memo(function AttentionCard({
  item,
  message,
  onMessage,
  onSettle,
  busy = false,
}: AttentionCardProps) {
  const inputId = useId();
  const headingId = useId();
  const go = useHrefNavigate();
  const takeover = item.mode === 'takeover';
  const Takeover = ICONS.takeover;
  const Session = ICONS.sessions;
  const Check = ICONS.check;
  const href = takeover ? takeoverHref(item.session_id) : sessionHref(item.session_id);
  const intercept = interceptOf(item);
  const write = intercept?.reason === 'write_confirm';
  return (
    <article
      aria-labelledby={headingId}
      className={cn(
        'relative flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card shadow-xs dark:shadow-none',
        'before:absolute before:inset-y-0 before:left-0 before:w-[3px]',
        takeover ? 'before:bg-warn-solid' : 'before:bg-info-solid',
      )}
    >
      <div className="flex min-w-0 flex-col gap-4 p-5 pl-6 lg:flex-row lg:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 text-sm">
            {intercept !== null ? <TonePill entry={interceptBadge(intercept)} /> : null}
            <TonePill entry={MODE_BADGE[takeover ? 'takeover' : 'notify']} />
            <WaitingFor row={item} className="font-medium text-warn-text" />
            <DeadlinePill deadlineAt={item.deadline_at} />
          </div>
          <Reason id={headingId} text={item.reason} />
          <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-muted-foreground">Session</dt>
            <dd className="min-w-0">
              <SessionRef id={item.session_id} slug={item.session_slug} />
            </dd>
            {item.page_url !== null ? (
              <>
                <dt className="text-muted-foreground">Page</dt>
                <dd className="min-w-0">
                  <UrlCell url={item.page_url} head={48} tail={24} className="min-w-0" />
                </dd>
              </>
            ) : null}
            {intercept !== null ? (
              <InterceptFacts options={intercept} pageUrl={item.page_url} />
            ) : item.kind === 'security_intercept' ? null : hasOptions(item.options) ? (
              <>
                <dt className="self-start pt-0.5 text-muted-foreground">Options</dt>
                <dd className="min-w-0">
                  <AgentOptions options={item.options} />
                </dd>
              </>
            ) : null}
          </dl>
          {intercept !== null && onlyDecidedHere(intercept) ? (
            <p className="text-sm text-muted-foreground">
              Sign-out, account, credential and destructive requests can only be decided here, not
              from a notification.
            </p>
          ) : null}
        </div>
        <RequestThumbnail sessionId={item.session_id} requestedAt={item.created_at} />
      </div>

      <div className="flex flex-col gap-3 border-t bg-muted/40 px-5 py-3 pl-6 sm:flex-row sm:items-center dark:bg-white/[0.02]">
        <label htmlFor={inputId} className="sr-only">
          Message back to agent
        </label>
        <Input
          id={inputId}
          size="sm"
          className="min-w-0 bg-card max-sm:h-10 sm:max-w-md sm:flex-1"
          placeholder="Optional message back to the agent"
          maxLength={500}
          value={message}
          onChange={(event) => onMessage(item.request_id, event.target.value)}
        />
        {/* DOM (and phone) order: the primary action first and full width, then the secondary one,
            Reject last. From 640px the row reads Reject · secondary · primary, right-aligned. */}
        <div className="grid grid-cols-2 gap-2 sm:ml-auto sm:flex sm:items-center">
          {takeover ? (
            <a
              href={href}
              className={cn(
                buttonVariants({ variant: 'default', size: 'sm' }),
                'col-span-2 max-sm:h-10 sm:order-3',
              )}
              onClick={(event) => {
                if (!isPlainClick(event)) return;
                event.preventDefault();
                go(href);
              }}
            >
              <Takeover aria-hidden="true" />
              Take over
            </a>
          ) : null}
          <Button
            type="button"
            variant={takeover ? 'outline' : 'default'}
            size="sm"
            disabled={busy}
            className={cn('max-sm:h-10 sm:order-2', !takeover && 'col-span-2 sm:order-3')}
            onClick={() => onSettle(item, 'resolve')}
          >
            <Check aria-hidden="true" />
            {write ? 'Approve' : 'Resolve'}
          </Button>
          {takeover ? null : (
            <a
              href={href}
              className={cn(
                buttonVariants({ variant: 'outline', size: 'sm' }),
                'max-sm:h-10 sm:order-2',
              )}
              onClick={(event) => {
                if (!isPlainClick(event)) return;
                event.preventDefault();
                go(href);
              }}
            >
              <Session aria-hidden="true" />
              Open session
            </a>
          )}
          <Button
            type="button"
            variant="destructive-ghost"
            size="sm"
            disabled={busy}
            className="max-sm:h-10 sm:order-1"
            onClick={() => onSettle(item, 'reject')}
          >
            {write ? 'Deny' : 'Reject'}
          </Button>
        </div>
      </div>
    </article>
  );
});

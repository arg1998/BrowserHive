/** @module features/sessions/detail/AttentionBanner — the "agent needs you" banner from this session's pending attention requests (never `counts`): reason, mode, wait and deadline, inline Resolve / Reject with an optional message, and Take over for takeover requests ; Reject reads as the destructive choice, like the Attention page */
import type { OperatorRequestRow, SessionSummary } from '@browserhive/contracts/http';
import { useId, useState } from 'react';
import { RelativeTime } from '@/components/shared/RelativeTime.tsx';
import { splitUrl } from '@/components/shared/url-cell.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx';
import { Textarea } from '@/components/ui/textarea.tsx';
import { useResolveAttention } from '@/features/attention/api.ts';
import { ICONS } from '@/lib/icons.ts';

/** Props. */
export interface AttentionBannerProps {
  readonly session: SessionSummary;
  readonly pending: readonly OperatorRequestRow[];
  readonly onTakeover: () => void;
}

function DecisionPopover({
  request,
  decision,
  sessionId,
}: {
  readonly request: OperatorRequestRow;
  readonly decision: 'resolve' | 'reject';
  readonly sessionId: string;
}) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const mutation = useResolveAttention();
  const id = useId();
  const resolve = decision === 'resolve';
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button type="button" variant={resolve ? 'outline' : 'destructive-ghost'} size="sm" />
        }
      >
        {resolve ? 'Resolve…' : 'Reject…'}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate(
              { requestId: request.request_id, decision, message: message.trim(), sessionId },
              { onSuccess: () => setOpen(false) },
            );
          }}
        >
          <div className="flex flex-col gap-0.5">
            <p className="text-base font-semibold">
              {resolve ? 'Resolve the request' : 'Reject the request'}
            </p>
            <p className="text-sm text-muted-foreground">
              {resolve
                ? 'The agent continues from where it asked for help.'
                : 'The agent is told you declined and handles it itself.'}
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={id} className="text-sm font-medium">
              Message to the agent{' '}
              <span className="font-normal text-muted-foreground">(optional)</span>
            </label>
            <Textarea
              id={id}
              rows={3}
              maxLength={500}
              value={message}
              placeholder={
                resolve ? 'Solved the captcha; you can continue.' : 'Not safe to proceed.'
              }
              onChange={(event) => setMessage(event.target.value)}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              variant={resolve ? 'default' : 'destructive-solid'}
              disabled={mutation.isPending}
            >
              {resolve ? 'Resolve' : 'Reject'}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

/** Banner (renders nothing without pending requests). */
export function AttentionBanner({ session, pending, onTakeover }: AttentionBannerProps) {
  const request = pending[0];
  if (request === undefined) return null;
  const Hand = ICONS.attention;
  const Takeover = ICONS.takeover;
  const takeover = request.mode === 'takeover' && session.live;
  const page = request.page_url !== null ? splitUrl(request.page_url) : null;
  return (
    <section
      aria-label="Attention request"
      className="flex flex-col gap-3 rounded-xl border border-warn-border bg-warn-bg px-4 py-3.5 sm:flex-row sm:items-start sm:gap-4"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-warn-solid text-warn-on-solid">
        <Hand aria-hidden="true" className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-base font-semibold text-foreground">
            {takeover ? 'The agent is asking you to take over' : 'The agent is waiting for you'}
          </span>
          <span className="text-sm text-muted-foreground">
            asked <RelativeTime at={request.created_at} className="min-w-0" />
            {request.deadline_at !== null ? (
              <>
                {' · '}times out <RelativeTime at={request.deadline_at} className="min-w-0" />
              </>
            ) : null}
            {pending.length > 1 ? ` · ${pending.length - 1} more waiting` : ''}
          </span>
        </p>
        <p className="text-base text-foreground/90 [overflow-wrap:break-word] whitespace-pre-wrap">
          {request.reason}
        </p>
        {page !== null ? (
          <p className="min-w-0 truncate font-mono text-sm text-muted-foreground">
            <span className="text-foreground/80">{page.host}</span>
            {page.rest}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
        <DecisionPopover request={request} decision="reject" sessionId={session.session_id} />
        <DecisionPopover request={request} decision="resolve" sessionId={session.session_id} />
        {takeover ? (
          <Button type="button" size="sm" onClick={onTakeover}>
            <Takeover aria-hidden="true" /> Take over
          </Button>
        ) : null}
      </div>
    </section>
  );
}

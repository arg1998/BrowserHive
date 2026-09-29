/** @module features/notifications/channels/DigestNowDialog — "Send a digest now" (D-43, spec 04 §12.11.1): previews the channel's real digest of the period that ends now in the platform mock (`POST /channels/{id}/digest {send: false}`, pure), says when that period was empty (a scheduled digest would not be sent), then sends it on demand and shows the result; the schedule is untouched */
import type { ChannelDigestResponse, ChannelView } from '@browserhive/contracts/http';
import { deliveryReasonText } from '@browserhive/contracts/notifications';
import { useEffect, useState } from 'react';
import { Callout } from '@/components/shared/Callout.tsx';
import { Button } from '@/components/ui/button.tsx';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { toAppError } from '@/lib/api/errors.ts';
import { formatMs } from '@/lib/format/time.ts';
import { ICONS } from '@/lib/icons.ts';
import { useChannelDigest } from './api.ts';
import { formatInZone, zoneLabel } from './model.ts';
import { PlatformPreview } from './preview/PlatformPreview.tsx';

/** Props. */
export interface DigestNowDialogProps {
  readonly channel: ChannelView;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/** The dialog. */
export function DigestNowDialog({ channel, open, onOpenChange }: DigestNowDialogProps) {
  const preview = useChannelDigest();
  const send = useChannelDigest();
  const [sent, setSent] = useState<ChannelDigestResponse | null>(null);
  const zone = channel.reports.time_zone;
  const weekly = channel.reports.digest?.every === 'week';
  const { mutate: load, reset: resetPreview } = preview;
  const { reset: resetSend } = send;

  useEffect(() => {
    if (!open) return;
    setSent(null);
    resetSend();
    resetPreview();
    load({ id: channel.channel_id, send: false });
  }, [open, channel.channel_id, load, resetPreview, resetSend]);

  const data = sent ?? preview.data ?? null;
  const Send = ICONS.sendTest;
  const Ok = ICONS.success;
  const busy = send.isPending;
  const error = preview.error ?? null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Send a digest now</DialogTitle>
          <DialogDescription>
            {weekly ? 'The last seven days' : 'The last 24 hours'}, from real activity, exactly as{' '}
            {channel.name} receives it. The schedule is not changed.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4 pb-1">
          {data !== null ? (
            <p className="text-sm text-muted-foreground">
              {formatInZone(data.window.since, zone)} → {formatInZone(data.window.until, zone)} ·{' '}
              {zoneLabel(zone)}
            </p>
          ) : null}
          {data?.empty === true ? (
            <Callout tone="info" title="Nothing happened in this period">
              A scheduled digest for a period like this is not sent (it is logged as “nothing
              happened”). Sending it now shows you what it would say.
            </Callout>
          ) : null}
          {error !== null ? (
            <Callout tone="danger" title="Could not build the digest">
              {toAppError(error).message}
            </Callout>
          ) : data === null ? (
            <div className="flex flex-col gap-3" aria-busy="true">
              <Skeleton className="h-5 w-2/3" />
              <Skeleton className="h-64 w-full rounded-xl" />
            </div>
          ) : (
            <PlatformPreview
              preview={data.preview}
              chatTitle={channel.target['chat_title'] ?? null}
            />
          )}
        </DialogBody>
        <DialogFooter className="items-center">
          <div className="mr-auto min-w-0 text-sm" role="status">
            {busy ? (
              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                <Spinner className="size-3.5" /> Sending…
              </span>
            ) : sent?.ok === true ? (
              <span className="inline-flex items-center gap-1.5 text-success-text">
                <Ok aria-hidden="true" className="size-4" />
                Digest sent
                {sent.delivery?.duration_ms !== null && sent.delivery?.duration_ms !== undefined
                  ? ` · ${formatMs(sent.delivery.duration_ms)}`
                  : ''}
              </span>
            ) : sent !== null ? (
              <span className="text-danger-text [overflow-wrap:anywhere]">
                Not sent: {deliveryReasonText(sent.error?.code ?? 'failed') ?? sent.error?.code}
                {sent.error?.message !== undefined ? (
                  <span className="block text-xs text-muted-foreground">{sent.error.message}</span>
                ) : null}
              </span>
            ) : send.error !== null ? (
              <span className="text-danger-text">{toAppError(send.error).message}</span>
            ) : channel.status === 'paused' ? (
              <span className="text-muted-foreground">Resume the channel to send it.</span>
            ) : !channel.ready ? (
              <span className="text-muted-foreground">
                {channel.problem ?? 'The channel cannot send yet.'}
              </span>
            ) : null}
          </div>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {sent?.ok === true ? 'Done' : 'Cancel'}
          </Button>
          <Button
            type="button"
            disabled={busy || data === null || !channel.ready || channel.status === 'paused'}
            onClick={() =>
              send.mutate(
                { id: channel.channel_id, send: true },
                { onSuccess: (result) => setSent(result) },
              )
            }
          >
            <Send aria-hidden="true" />
            {sent?.ok === true ? 'Send again' : 'Send now'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

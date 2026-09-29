/** @module features/notifications/channels/wizard/StepPreview — step 5: a sample picker and the near-exact platform mock of the draft (drawn from `POST /channels/preview`, the same renderer a send uses), then Save and Send test; the test message carries "Open dashboard", which is the public-address check from the phone */
import type { ChannelTestResponse } from '@browserhive/contracts/http';
import {
  deliveryReasonText,
  PREVIEW_SAMPLE_LABEL,
  PREVIEW_SAMPLES,
  type PreviewSample,
} from '@browserhive/contracts/notifications';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { Callout } from '@/components/shared/Callout.tsx';
import { Button, buttonVariants } from '@/components/ui/button.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { toAppError } from '@/lib/api/errors.ts';
import { formatMs } from '@/lib/format/time.ts';
import { ICONS } from '@/lib/icons.ts';
import { cn } from '@/lib/utils.ts';
import { useChannelPreview, useTestChannel } from '../api.ts';
import { type ChannelDraft, cleanRules } from '../model.ts';
import { PlatformPreview } from '../preview/PlatformPreview.tsx';

/** Props. */
export interface StepPreviewProps {
  readonly draft: ChannelDraft;
  /** The saved channel (after Save, or when editing). */
  readonly channelId: string | null;
  /** The saved channel can send (its variables are set). */
  readonly ready: boolean;
  readonly readOnly: boolean;
}

function TestResult({ result }: { readonly result: ChannelTestResponse }) {
  if (result.ok) {
    return (
      <Callout tone="success" title="Test message sent">
        Check your {result.delivery?.channel_kind ?? 'app'}: it should be there
        {result.delivery?.duration_ms !== null && result.delivery?.duration_ms !== undefined
          ? ` (the platform answered in ${formatMs(result.delivery.duration_ms)})`
          : ''}
        . Tap <span className="font-medium">Open dashboard</span> on your phone: if this dashboard
        opens, your public address works.
      </Callout>
    );
  }
  const code = result.error?.code ?? result.delivery?.reason ?? 'failed';
  return (
    <Callout tone="danger" title="The test did not go through">
      {deliveryReasonText(code) ?? code}
      {result.error?.message !== undefined ? (
        <span className="mt-1 block font-mono text-xs [overflow-wrap:anywhere]">
          {result.error.message}
        </span>
      ) : null}
    </Callout>
  );
}

/** Step 5. */
export function StepPreview({ draft, channelId, ready, readOnly }: StepPreviewProps) {
  const [sample, setSample] = useState<PreviewSample>('attention');
  const preview = useChannelPreview(
    draft.kind === null
      ? null
      : channelId !== null && readOnly
        ? { channel_id: channelId, sample }
        : {
            kind: draft.kind,
            mode: draft.mode,
            target: { ...draft.target },
            rules: cleanRules(draft.rules),
            sample,
          },
  );
  const test = useTestChannel();
  const Send = ICONS.sendTest;
  const Log = ICONS.deliveryLog;
  return (
    <div className="flex flex-col gap-5">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-base font-medium">Preview a notification</legend>
        <div className="flex flex-wrap gap-1.5">
          {PREVIEW_SAMPLES.map((s) => (
            <label
              key={s}
              className={cn(
                'inline-flex h-8 cursor-pointer items-center rounded-full border px-3 text-sm transition-colors has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-ring',
                sample === s
                  ? 'border-accent-border bg-accent-bg text-accent-text'
                  : 'text-muted-foreground hover:border-border-strong hover:text-foreground',
              )}
            >
              <input
                type="radio"
                name="preview-sample"
                value={s}
                checked={sample === s}
                onChange={() => setSample(s)}
                className="sr-only"
              />
              {PREVIEW_SAMPLE_LABEL[s]}
            </label>
          ))}
        </div>
      </fieldset>

      <div
        className={cn(
          'min-h-64 transition-opacity',
          preview.isFetching && preview.data !== undefined && 'opacity-70',
        )}
      >
        {preview.data !== undefined ? (
          <PlatformPreview preview={preview.data} chatTitle={draft.target['chat_title'] ?? null} />
        ) : preview.isError ? (
          <Callout tone="danger" title="The preview could not be drawn">
            {toAppError(preview.error).message}
          </Callout>
        ) : (
          <Skeleton className="h-72 w-full rounded-xl" />
        )}
      </div>

      {channelId !== null ? (
        <div className="flex flex-col gap-3 rounded-xl border p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-col">
              <h3 className="text-base font-medium">Send a real test</h3>
              <p className="text-sm text-muted-foreground">
                A test message goes out now through the platform, with an Open dashboard link.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Link
                to="/notifications/log"
                search={{ channel: channelId }}
                className={buttonVariants({ variant: 'ghost', size: 'sm' })}
              >
                <Log aria-hidden="true" />
                Delivery log
              </Link>
              <Button
                type="button"
                size="sm"
                disabled={!ready || test.isPending}
                onClick={() => test.mutate(channelId)}
              >
                {test.isPending ? <Spinner /> : <Send aria-hidden="true" />}
                Send test
              </Button>
            </div>
          </div>
          {!ready ? (
            <p className="text-sm text-warn-text">
              The channel cannot send yet: set its variables and restart BrowserHive.
            </p>
          ) : null}
          {test.data !== undefined ? <TestResult result={test.data} /> : null}
          {test.isError ? (
            <Callout tone="danger" title="The test could not be sent">
              {toAppError(test.error).message}
            </Callout>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** @module features/notifications/channels/preview/PlatformPreview — renders a `ChannelPreview` as the platform would show it (Telegram, Discord, ntfy mocks, the webhook request), with the renderer's notes and a disclosure of the exact request(s); everything is drawn from `requests`, the same output a real send uses (spec 04 §12.11.1) */
import type { ChannelPreview, PlatformRequest } from '@browserhive/contracts/http';
import { type ReactNode, useId, useState } from 'react';
import { JsonView } from '@/components/shared/JsonView.tsx';
import { ICONS } from '@/lib/icons.ts';
import { cn } from '@/lib/utils.ts';
import { DiscordMock } from './DiscordMock.tsx';
import { NtfyMock } from './NtfyMock.tsx';
import { TelegramMock } from './TelegramMock.tsx';

/** Whether the previewed message carries a masked image. */
function maskedOf(preview: ChannelPreview): boolean {
  return preview.message.blocks.some((b) => b.type === 'image' && b.masked);
}

function WebhookMock({ request }: { readonly request: PlatformRequest }) {
  const headers = { 'Content-Type': 'application/json', ...request.headers };
  return (
    <div className="overflow-hidden rounded-xl border bg-card" data-platform="webhook">
      <div className="flex flex-wrap items-center gap-2 border-b bg-muted/60 px-4 py-2.5 font-mono text-sm dark:bg-white/[0.03]">
        <span className="rounded-sm bg-accent-bg px-1.5 py-px text-xs font-semibold text-accent-text">
          {request.method}
        </span>
        <span className="min-w-0 break-all text-muted-foreground">{request.path}</span>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 border-b px-4 py-2.5 font-mono text-xs">
        {Object.entries(headers).map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="min-w-0 break-all">{v}</dd>
          </div>
        ))}
        <div className="contents">
          <dt className="text-muted-foreground">X-BrowserHive-Signature</dt>
          <dd className="text-subtle-foreground">sha256=… (when a signing secret is set)</dd>
        </div>
      </dl>
      <div className="max-h-[28rem] overflow-auto p-3">
        <JsonView value={request.body} collapseAt={3} />
      </div>
    </div>
  );
}

/** Props. */
export interface PlatformPreviewProps {
  readonly preview: ChannelPreview;
  /** Chat title shown in the Telegram header (a connected chat). */
  readonly chatTitle?: string | null;
  readonly className?: string;
  /** Hide the request disclosure (the side-by-side comparison). */
  readonly compact?: boolean;
}

/** One platform mock for a preview. */

/** A note with the config key `publicUrl` (when present) rendered as code. */
function withCodeTerms(note: string): ReactNode {
  const at = note.indexOf('publicUrl');
  if (at < 0) return note;
  return (
    <>
      {note.slice(0, at)}
      <code className="font-mono">publicUrl</code>
      {note.slice(at + 'publicUrl'.length)}
    </>
  );
}

export function PlatformPreview({
  preview,
  chatTitle,
  className,
  compact = false,
}: PlatformPreviewProps) {
  const [showRequest, setShowRequest] = useState(false);
  const id = useId();
  const request = preview.requests[0];
  const at = preview.message.at.updated;
  const masked = maskedOf(preview);
  const Code = ICONS.json;
  const Info = ICONS.info;
  if (request === undefined) {
    return (
      <p className="rounded-xl border px-4 py-6 text-center text-sm text-muted-foreground">
        This notification sends nothing on this channel.
      </p>
    );
  }
  return (
    <div className={cn('flex min-w-0 flex-col gap-3', className)}>
      {preview.kind === 'telegram' ? (
        <TelegramMock request={request} at={at} masked={masked} chatTitle={chatTitle ?? null} />
      ) : preview.kind === 'discord' ? (
        <DiscordMock
          request={request}
          at={at}
          masked={masked}
          mode={preview.mode === 'bot' ? 'bot' : 'webhook'}
        />
      ) : preview.kind === 'ntfy' ? (
        <NtfyMock
          request={request}
          at={at}
          masked={masked}
          revised={preview.message.revision > 1}
        />
      ) : (
        <WebhookMock request={request} />
      )}
      {!compact && preview.notes.length > 0 ? (
        <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
          {preview.notes.map((note) => (
            <li key={note} className="flex gap-2">
              <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <span>{withCodeTerms(note)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {!compact ? (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            className="inline-flex w-fit cursor-pointer items-center gap-1.5 rounded-sm text-sm text-link hover:underline focus-ring"
            aria-expanded={showRequest}
            aria-controls={id}
            onClick={() => setShowRequest((v) => !v)}
          >
            <Code aria-hidden="true" className="size-4" />
            {showRequest
              ? 'Hide the request'
              : `Show the request${preview.requests.length > 1 ? 's' : ''}`}
          </button>
          {showRequest ? (
            <div
              id={id}
              className="max-h-[28rem] overflow-auto rounded-lg border bg-muted/40 p-3 dark:bg-white/[0.02]"
            >
              <JsonView value={preview.requests} collapseAt={4} />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** @module features/notifications/channels/preview/NtfyMock — an Android notification as the ntfy app shows it, drawn from the renderer's publish request: app row with topic, priority, emoji tags before the title, the message, an attached image and the action buttons (`http` ones answer through the reply topic, D-42). Our own CSS; no ntfy assets. */
import type { PlatformRequest } from '@browserhive/contracts/http';
import { ICONS } from '@/lib/icons.ts';
import { cn } from '@/lib/utils.ts';
import { MockAction, MockScreenshot } from './MockParts.tsx';
import { readNtfy, splitNtfyTags } from './read-request.ts';

const PRIORITY_LABEL: Readonly<Record<number, string>> = {
  1: 'min',
  2: 'low',
  3: 'default',
  4: 'high',
  5: 'urgent',
};

/** Props. */
export interface NtfyMockProps {
  readonly request: PlatformRequest;
  readonly at: number;
  readonly masked: boolean;
  readonly topic?: string | null;
  /** A later revision: say that it replaces the first notification. */
  readonly revised?: boolean;
}

/** The ntfy notification mock. */
export function NtfyMock({ request, at, masked, topic, revised = false }: NtfyMockProps) {
  const view = readNtfy(request);
  const { emoji, plain } = splitNtfyTags(view.tags);
  const time = new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const Bell = ICONS.platformNtfy;
  const Warn = ICONS.warn;
  const Answer = ICONS.answer;
  const shownTopic = view.topic ?? topic ?? 'topic';
  return (
    <div className="rounded-xl border bg-nt-shade p-3 sm:p-4" data-platform="ntfy">
      <div className="mx-auto flex max-w-[26rem] flex-col gap-2 rounded-[1.25rem] bg-nt-card p-4 text-nt-text shadow-sm">
        <div className="flex items-center gap-2 text-xs text-nt-muted">
          <span className="flex size-5 items-center justify-center rounded-full bg-nt-accent text-nt-card">
            <Bell aria-hidden="true" className="size-3" />
          </span>
          <span className="font-medium text-nt-text">ntfy</span>
          <span aria-hidden="true">•</span>
          <span className="truncate">{shownTopic}</span>
          <span aria-hidden="true">•</span>
          <span>{time}</span>
          {view.priority >= 4 ? (
            <span
              className={cn(
                'ml-auto inline-flex items-center gap-1 rounded-full px-1.5 py-px font-medium',
                view.priority === 5 ? 'bg-danger-bg text-danger-text' : 'bg-nt-chip text-nt-accent',
              )}
            >
              <Warn aria-hidden="true" className="size-3" />
              {PRIORITY_LABEL[view.priority]}
            </span>
          ) : (
            <span className="ml-auto text-nt-muted">{PRIORITY_LABEL[view.priority]} priority</span>
          )}
        </div>
        {view.title !== null ? (
          <p className="text-[0.95rem] leading-snug font-semibold">
            {emoji.length > 0 ? <span className="mr-1">{emoji.join(' ')}</span> : null}
            {view.title}
          </p>
        ) : null}
        <p className="text-[0.875rem] leading-snug whitespace-pre-wrap text-nt-text/90">
          {view.title === null && emoji.length > 0 ? (
            <span className="mr-1">{emoji.join(' ')}</span>
          ) : null}
          {view.message}
        </p>
        {plain.length > 0 ? (
          <p className="text-xs text-nt-muted">Tags: {plain.join(', ')}</p>
        ) : null}
        {view.attachment !== null ? (
          <MockScreenshot masked={masked} name={view.attachment} className="rounded-xl" />
        ) : null}
        {view.actions.length > 0 ? (
          <div className="flex flex-wrap gap-2 pt-1">
            {view.actions.map((a) =>
              a.kind === 'http' ? (
                <button
                  key={`${a.label}|${a.url ?? a.kind}`}
                  type="button"
                  title="Tapping posts the answer to the reply topic; BrowserHive acts on it"
                  className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full bg-nt-accent px-3.5 text-[0.8rem] font-medium text-nt-card transition hover:brightness-110 focus-ring"
                >
                  <Answer aria-hidden="true" className="size-3.5" />
                  {a.label}
                </button>
              ) : (
                <MockAction
                  key={`${a.label}|${a.url ?? a.kind}`}
                  url={a.url}
                  className="inline-flex h-8 cursor-pointer items-center rounded-full bg-nt-chip px-3.5 text-[0.8rem] font-medium text-nt-accent transition hover:brightness-95 focus-ring dark:hover:brightness-125"
                >
                  {a.label}
                </MockAction>
              ),
            )}
          </div>
        ) : null}
      </div>
      {view.sequence !== null && revised ? (
        <p className="mt-2 text-center text-xs text-muted-foreground">
          Replaces the first notification in place (sequence id{' '}
          <span className="font-mono">{view.sequence}</span>)
        </p>
      ) : null}
    </div>
  );
}

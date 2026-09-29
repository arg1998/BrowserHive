/** @module features/notifications/channels/preview/DiscordMock — a Discord message drawn from the renderer's webhook request: the sender row with its APP tag, the embed (colour bar from the payload, title, markdown description, inline fields, image, footer) and the button rows (link buttons, and interactive ones in bot mode). Our own CSS; no Discord assets. */
import type { PlatformRequest } from '@browserhive/contracts/http';
import { ICONS } from '@/lib/icons.ts';
import { cn } from '@/lib/utils.ts';
import { DiscordMarkdown } from './discord-markdown.tsx';
import { MockAction, MockScreenshot, SenderAvatar } from './MockParts.tsx';
import { type MockButton, readDiscord } from './read-request.ts';

const BUTTON_TONE: { readonly [S in MockButton['style']]: string } = {
  primary: 'bg-dc-primary hover:brightness-110',
  secondary: 'bg-dc-button hover:brightness-110',
  success: 'bg-dc-success hover:brightness-110',
  danger: 'bg-dc-danger hover:brightness-110',
  link: 'bg-dc-button hover:brightness-110',
};

/** `#rrggbb` of a Discord colour integer. */
export function discordHex(color: number): string {
  return `#${Math.max(0, Math.min(0xffffff, color)).toString(16).padStart(6, '0')}`;
}

/** Props. */
export interface DiscordMockProps {
  readonly request: PlatformRequest;
  readonly at: number;
  readonly masked: boolean;
  /** `bot` shows the BOT tag and interactive buttons as pressable. */
  readonly mode: 'webhook' | 'bot';
}

/** The Discord message mock. */
export function DiscordMock({ request, at, masked, mode }: DiscordMockProps) {
  const view = readDiscord(request);
  const time = new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const External = ICONS.external;
  return (
    <div
      className="rounded-xl border bg-dc-bg px-3 py-4 text-dc-text sm:px-4"
      data-platform="discord"
    >
      <div className="flex gap-3">
        <SenderAvatar className="size-10" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-baseline gap-x-1.5">
            <span className="font-semibold text-dc-heading">BrowserHive</span>
            <span className="rounded-[0.2rem] bg-dc-primary px-1 text-[0.625rem] leading-4 font-semibold tracking-wide text-white uppercase">
              {mode === 'bot' ? 'Bot' : 'App'}
            </span>
            <span className="text-xs text-dc-muted">Today at {time}</span>
            {view.edit ? <span className="text-xs text-dc-muted">(edited)</span> : null}
          </div>
          {view.content !== null && view.content !== '' ? (
            <div className="text-[0.9rem] leading-snug">
              <DiscordMarkdown text={view.content} />
            </div>
          ) : null}
          {view.embeds.map((embed) => (
            <article
              key={`${embed.title ?? ''}|${embed.description?.slice(0, 40) ?? ''}`}
              className="grid max-w-[32rem] gap-2 rounded-[0.25rem] border-l-4 bg-dc-embed p-3 pr-4 text-[0.84rem] leading-snug"
              // The payload's own colour (data from the renderer, not a design token).
              style={{
                borderLeftColor: embed.color === null ? undefined : discordHex(embed.color),
              }}
            >
              {embed.title !== null ? (
                <h4 className="text-[0.95rem] font-semibold text-dc-heading">
                  {embed.url !== null ? (
                    <a
                      href={embed.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-dc-link hover:underline"
                    >
                      {embed.title}
                    </a>
                  ) : (
                    embed.title
                  )}
                </h4>
              ) : null}
              {embed.description !== null ? (
                <div className="min-w-0 break-words">
                  <DiscordMarkdown text={embed.description} />
                </div>
              ) : null}
              {embed.fields.length > 0 ? (
                <div className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-3">
                  {embed.fields.map((f) => (
                    <div
                      key={`${f.name}|${f.value.slice(0, 40)}`}
                      className={cn('min-w-0', !f.inline && 'sm:col-span-3')}
                    >
                      <div className="text-xs font-semibold text-dc-heading">{f.name}</div>
                      <div className="min-w-0 break-words">
                        <DiscordMarkdown text={f.value} />
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
              {embed.image !== null ? (
                <MockScreenshot
                  masked={masked}
                  name={embed.image.replace(/^attachment:\/\//, '')}
                  className="mt-1 rounded-md"
                />
              ) : null}
              {embed.footer !== null || embed.timestamp !== null ? (
                <div className="flex flex-wrap items-center gap-1 text-xs text-dc-muted">
                  {embed.footer !== null ? <span>{embed.footer}</span> : null}
                  {embed.footer !== null && embed.timestamp !== null ? (
                    <span aria-hidden="true">•</span>
                  ) : null}
                  {embed.timestamp !== null ? <span>Today at {time}</span> : null}
                </div>
              ) : null}
            </article>
          ))}
          {view.rows.map((row) => (
            <div key={row.map((b) => b.label).join('|')} className="flex flex-wrap gap-2 pt-1">
              {row.map((b) => (
                <MockAction
                  key={`${b.label}|${b.url ?? b.style}`}
                  url={b.url}
                  className={cn(
                    'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[0.2rem] px-4 text-[0.84rem] font-medium text-dc-button-text transition focus-ring',
                    BUTTON_TONE[b.style],
                  )}
                >
                  {b.label}
                  {b.style === 'link' ? <External aria-hidden="true" className="size-3.5" /> : null}
                </MockAction>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

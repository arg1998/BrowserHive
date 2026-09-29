/** @module features/notifications/channels/preview/TelegramMock — a Telegram chat drawn from the renderer's request: a Rich Message (`sendRichMessage` / `editMessageText` with `rich_message`: headings, paragraphs, tables, lists, expandable quotes, code, footers and the inline screenshot, D-40) or the classic `sendMessage`/`sendPhoto` HTML subset; the bot header, the silent-send mark and the inline keyboard with callback buttons tinted by style. Our own CSS; no Telegram assets. */
import type { PlatformRequest } from '@browserhive/contracts/http';
import { type ReactNode, useState } from 'react';
import { ICONS } from '@/lib/icons.ts';
import { cn } from '@/lib/utils.ts';
import { MockAction, MockScreenshot, SenderAvatar } from './MockParts.tsx';
import { readTelegram } from './read-request.ts';
import { parseTelegramHtml, type TgNode } from './telegram-html.ts';

function ExpandableQuote({ children }: { readonly children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const More = open ? ICONS.chevronUp : ICONS.chevronDown;
  return (
    <span className="my-1 flex rounded-md border-l-[3px] border-tg-quote bg-tg-quote/10 py-1 pr-1 pl-2">
      <span className={cn('min-w-0 flex-1 whitespace-pre-wrap', !open && 'line-clamp-3')}>
        {children}
      </span>
      <button
        type="button"
        className="ml-1 flex size-5 shrink-0 cursor-pointer items-center justify-center self-end rounded-sm text-tg-quote hover:bg-tg-quote/15 focus-ring"
        aria-label={open ? 'Collapse quote' : 'Expand quote'}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <More aria-hidden="true" className="size-3.5" />
      </button>
    </span>
  );
}

function Spoiler({ children }: { readonly children: ReactNode }) {
  const [shown, setShown] = useState(false);
  return (
    <button
      type="button"
      className={cn(
        'inline cursor-pointer rounded-sm px-0.5 focus-ring',
        shown ? 'bg-transparent' : 'bg-tg-muted/60 text-transparent blur-[2px]',
      )}
      aria-label={shown ? undefined : 'Show hidden text'}
      onClick={() => setShown(true)}
    >
      {children}
    </button>
  );
}

/** What the node renderer needs besides the nodes. */
interface RenderCtx {
  readonly masked: boolean;
}

function renderNodes(nodes: readonly TgNode[], key: string, ctx: RenderCtx): ReactNode[] {
  return nodes.map((node, i) => renderNode(node, `${key}.${i}`, ctx));
}

const HEADING: Readonly<Record<number, string>> = {
  1: 'text-[1.3rem] font-bold',
  2: 'text-[1.18rem] font-bold',
  3: 'text-[1.05rem] font-semibold',
  4: 'text-[0.95rem] font-semibold',
  5: 'text-[0.9rem] font-semibold',
  6: 'text-[0.9rem] font-semibold',
};

function renderNode(node: TgNode, k: string, ctx: RenderCtx): ReactNode {
  if (node.type === 'text') return <span key={k}>{node.text}</span>;
  const children = renderNodes(node.children, k, ctx);
  switch (node.tag) {
    case 'b':
      return (
        <strong key={k} className="font-semibold">
          {children}
        </strong>
      );
    case 'i':
      return <em key={k}>{children}</em>;
    case 'u':
      return (
        <span key={k} className="underline">
          {children}
        </span>
      );
    case 's':
      return <s key={k}>{children}</s>;
    case 'code':
      return (
        <code
          key={k}
          className="rounded-sm bg-tg-quote/12 px-1 font-mono text-[0.86em] text-tg-link"
        >
          {children}
        </code>
      );
    case 'pre':
      return (
        <pre
          key={k}
          className="my-1 overflow-x-auto rounded-md bg-tg-quote/10 p-2 font-mono text-[0.84em] whitespace-pre-wrap"
        >
          {children}
        </pre>
      );
    case 'a':
      return (
        <a
          key={k}
          href={node.href}
          target="_blank"
          rel="noreferrer noopener"
          className="text-tg-link underline-offset-2 hover:underline"
        >
          {children}
        </a>
      );
    case 'blockquote':
      return node.expandable === true ? (
        <ExpandableQuote key={k}>{children}</ExpandableQuote>
      ) : (
        <span
          key={k}
          className="my-1 block rounded-md border-l-[3px] border-tg-quote bg-tg-quote/10 py-1 pl-2 whitespace-pre-wrap"
        >
          {children}
        </span>
      );
    case 'spoiler':
      return <Spoiler key={k}>{children}</Spoiler>;
    case 'time':
      // Telegram shows `<tg-time>` in the reader's own time zone; the fallback text stands in.
      return (
        <span key={k} className="underline decoration-dotted underline-offset-2">
          {node.unix === undefined
            ? children
            : new Date(node.unix * 1000).toLocaleString([], {
                hour: '2-digit',
                minute: '2-digit',
                day: 'numeric',
                month: 'short',
              })}
        </span>
      );
    case 'emoji':
      return <span key={k}>{children}</span>;
    case 'h':
      return (
        <span key={k} className={cn('mt-1 mb-1.5 block leading-tight', HEADING[node.level ?? 3])}>
          {children}
        </span>
      );
    case 'p':
      return (
        <span key={k} className="mb-2 block last:mb-0">
          {children}
        </span>
      );
    case 'br':
      return <br key={k} />;
    case 'hr':
      return <span key={k} aria-hidden="true" className="my-2 block h-px bg-tg-muted/35" />;
    case 'img':
      return (
        <span key={k} className="-mx-3 my-2 block">
          <MockScreenshot masked={ctx.masked} name="screenshot.jpg" />
        </span>
      );
    case 'figure':
      return (
        <span key={k} className="my-2 block">
          {children}
        </span>
      );
    case 'figcaption':
      return (
        <span key={k} className="mt-1 block text-xs text-tg-muted">
          {children}
        </span>
      );
    case 'table':
      return (
        <span
          key={k}
          className={cn(
            'my-2 block overflow-x-auto rounded-lg',
            node.bordered === true && 'border border-tg-muted/30',
          )}
        >
          <table
            className={cn(
              'w-full border-collapse text-[0.84rem]',
              // A bordered table keeps its first column off the border; a fields table is flush.
              node.bordered === true
                ? '[&_td:first-child]:pl-2 [&_tr:nth-child(even)]:bg-tg-muted/[0.06]'
                : '',
            )}
          >
            <tbody>{children}</tbody>
          </table>
        </span>
      );
    case 'tr':
      return (
        <tr key={k} className="border-b border-tg-muted/20 last:border-b-0">
          {children}
        </tr>
      );
    case 'th':
      return (
        <th key={k} className="px-2 py-1 text-left align-top font-semibold">
          {children}
        </th>
      );
    case 'td':
      return (
        <td key={k} className="px-2 py-1 align-top first:pl-0 [&:first-child>strong]:text-tg-muted">
          {children}
        </td>
      );
    case 'ul':
      return (
        <ul key={k} className="mb-2 list-disc pl-5">
          {children}
        </ul>
      );
    case 'ol':
      return (
        <ol key={k} className="mb-2 list-decimal pl-5">
          {children}
        </ol>
      );
    case 'li':
      return <li key={k}>{children}</li>;
    case 'footer':
      return (
        <span key={k} className="mt-2 block text-[0.78rem] text-tg-muted">
          {children}
        </span>
      );
  }
}

const KEY_TINT: Readonly<Record<string, string>> = {
  success: 'bg-tg-key-success text-white hover:brightness-110',
  danger: 'bg-tg-key-danger text-white hover:brightness-110',
  primary: 'bg-tg-key-primary text-white hover:brightness-110',
};

/** Props. */
export interface TelegramMockProps {
  readonly request: PlatformRequest;
  /** Epoch ms shown as the send time. */
  readonly at: number;
  readonly masked: boolean;
  readonly botName?: string;
  readonly chatTitle?: string | null;
}

/** The Telegram chat mock. */
export function TelegramMock({ request, at, masked, botName, chatTitle }: TelegramMockProps) {
  const view = readTelegram(request);
  const nodes = parseTelegramHtml(view.html, { rich: view.rich });
  const ctx: RenderCtx = { masked };
  const time = new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const Silent = ICONS.notificationsOff;
  const Arrow = ICONS.arrowUpRight;
  const Reply = ICONS.enter;
  return (
    <div
      className="overflow-hidden rounded-xl border bg-gradient-to-br from-tg-wall to-tg-wall-2 text-tg-text"
      data-platform="telegram"
    >
      <div className="flex items-center gap-2.5 border-b border-black/5 bg-tg-bubble/85 px-3 py-2 backdrop-blur dark:border-white/5">
        <SenderAvatar className="size-8" />
        <div className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-sm font-semibold">
            {chatTitle ?? botName ?? 'BrowserHive'}
          </span>
          <span className="text-xs text-tg-muted">
            {chatTitle !== null && chatTitle !== undefined ? 'group' : 'bot'}
          </span>
        </div>
      </div>
      <div className="flex flex-col items-start gap-1.5 px-3 py-4 sm:px-4">
        <div className="w-full max-w-[25rem]">
          <div
            className={cn(
              'overflow-hidden rounded-2xl rounded-bl-md bg-tg-bubble text-[0.9rem] leading-snug shadow-sm',
            )}
          >
            {view.reply ? (
              <div className="mx-2.5 mt-2 flex items-center gap-1.5 rounded-md border-l-[3px] border-tg-quote bg-tg-quote/10 px-2 py-1 text-xs text-tg-quote">
                <Reply aria-hidden="true" className="size-3" />
                Reply to the first message of this thread
              </div>
            ) : null}
            {view.photo !== null ? <MockScreenshot masked={masked} name={view.photo.name} /> : null}
            <div
              className={cn(
                'px-3 pt-2 pb-1.5 break-words',
                view.rich ? 'whitespace-normal' : 'whitespace-pre-wrap',
              )}
            >
              {renderNodes(nodes, 'm', ctx)}
              <span className="float-right mt-1.5 ml-3 inline-flex translate-y-0.5 items-center gap-1 text-[0.7rem] text-tg-muted">
                {view.edit ? 'edited ' : ''}
                {view.silent ? <Silent aria-label="Sent silently" className="size-3" /> : null}
                {time}
              </span>
            </div>
          </div>
          {view.rows.length > 0 ? (
            <div className="mt-1 flex flex-col gap-1">
              {view.rows.map((row) => (
                <div key={row.map((b) => b.label).join('|')} className="flex gap-1">
                  {row.map((b) => (
                    <MockAction
                      key={`${b.label}|${b.url ?? ''}`}
                      url={b.url}
                      className={cn(
                        'relative flex min-h-9 min-w-0 flex-1 cursor-pointer items-center justify-center rounded-lg px-6 py-1.5 text-center text-[0.84rem] font-medium backdrop-blur-sm transition focus-ring',
                        KEY_TINT[b.style] ?? 'bg-tg-key text-tg-key-text hover:bg-tg-key/70',
                      )}
                    >
                      <span className="truncate">{b.label}</span>
                      {b.url !== null ? (
                        <Arrow
                          aria-hidden="true"
                          className="absolute top-1 right-1 size-2.5 opacity-80"
                        />
                      ) : null}
                    </MockAction>
                  ))}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

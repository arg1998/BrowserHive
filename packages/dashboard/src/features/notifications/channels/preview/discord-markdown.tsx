/** @module features/notifications/channels/preview/discord-markdown — the slice of Discord markdown embeds use (bold, italic, underline, strikethrough, inline code, masked links, block quotes, bullets, backslash escapes) rendered as React text nodes; never HTML */
import type { ReactNode } from 'react';

/** An inline token. */
export type MdToken =
  | { readonly t: 'text'; readonly v: string }
  | { readonly t: 'code'; readonly v: string }
  | { readonly t: 'b' | 'i' | 'u' | 's'; readonly c: readonly MdToken[] }
  | { readonly t: 'link'; readonly label: readonly MdToken[]; readonly href: string }
  | { readonly t: 'time'; readonly unix: number; readonly style: string };

const PAIRS: readonly (readonly [string, 'b' | 'i' | 'u' | 's'])[] = [
  ['**', 'b'],
  ['__', 'u'],
  ['~~', 's'],
  ['*', 'i'],
  ['_', 'i'],
];

/** A Discord timestamp in the viewer's locale, per its style letter. */
export function formatDiscordTime(unix: number, style: string): string {
  const d = new Date(unix * 1000);
  switch (style) {
    case 't':
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    case 'T':
      return d.toLocaleTimeString();
    case 'd':
      return d.toLocaleDateString();
    case 'D':
      return d.toLocaleDateString([], { dateStyle: 'long' });
    case 'R':
      return d.toLocaleString();
    default:
      return d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  }
}

/** Parses one line of inline markdown. */
export function parseInline(text: string): readonly MdToken[] {
  const out: MdToken[] = [];
  let buf = '';
  const flush = () => {
    if (buf !== '') out.push({ t: 'text', v: buf });
    buf = '';
  };
  let i = 0;
  outer: while (i < text.length) {
    const ch = text[i] ?? '';
    if (ch === '\\' && i + 1 < text.length) {
      buf += text[i + 1];
      i += 2;
      continue;
    }
    if (ch === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i) {
        flush();
        out.push({ t: 'code', v: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (ch === '<') {
      const m = /^<t:(-?\d+)(?::([tTdDfFR]))?>/.exec(text.slice(i));
      if (m !== null) {
        flush();
        out.push({ t: 'time', unix: Number(m[1]), style: m[2] ?? 'f' });
        i += m[0].length;
        continue;
      }
    }
    if (ch === '[') {
      const m = /^\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/.exec(text.slice(i));
      if (m !== null) {
        flush();
        out.push({ t: 'link', label: parseInline(m[1] ?? ''), href: m[2] ?? '' });
        i += m[0].length;
        continue;
      }
    }
    for (const [mark, t] of PAIRS) {
      if (!text.startsWith(mark, i)) continue;
      const end = text.indexOf(mark, i + mark.length);
      if (end > i + mark.length - 1 && end !== i + mark.length) {
        flush();
        out.push({ t, c: parseInline(text.slice(i + mark.length, end)) });
        i = end + mark.length;
        continue outer;
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

function renderTokens(tokens: readonly MdToken[], key: string): ReactNode[] {
  return tokens.map((token, n) => renderToken(token, `${key}.${n}`));
}

function renderToken(token: MdToken, k: string): ReactNode {
  switch (token.t) {
    case 'text':
      return <span key={k}>{token.v}</span>;
    case 'code':
      return (
        <code
          key={k}
          className="rounded-sm bg-black/10 px-1 py-px font-mono text-[0.85em] dark:bg-black/30"
        >
          {token.v}
        </code>
      );
    case 'b':
      return (
        <strong key={k} className="font-semibold text-dc-heading">
          {renderTokens(token.c, k)}
        </strong>
      );
    case 'i':
      return <em key={k}>{renderTokens(token.c, k)}</em>;
    case 'u':
      return (
        <span key={k} className="underline">
          {renderTokens(token.c, k)}
        </span>
      );
    case 's':
      return (
        <s key={k} className="opacity-80">
          {renderTokens(token.c, k)}
        </s>
      );
    case 'time':
      // Discord shows `<t:unix:style>` in the reader's own time zone.
      return (
        <span key={k} className="rounded-sm bg-black/10 px-1 dark:bg-white/10">
          {formatDiscordTime(token.unix, token.style)}
        </span>
      );
    case 'link':
      return (
        <a
          key={k}
          href={token.href}
          target="_blank"
          rel="noreferrer noopener"
          className="text-dc-link hover:underline"
        >
          {renderTokens(token.label, k)}
        </a>
      );
  }
}

/** Renders a block of Discord markdown (lines, `> ` quotes, `- ` bullets). */
export function DiscordMarkdown({ text }: { readonly text: string }) {
  const lines = text.split('\n');
  return (
    <>
      {lines.map((line, n) => {
        const key = `l${n}`;
        if (line.startsWith('> ')) {
          return (
            <div key={key} className="my-0.5 border-l-4 border-dc-muted/50 pl-2.5">
              {renderTokens(parseInline(line.slice(2)), key)}
            </div>
          );
        }
        const bullet = /^\s*[-•]\s+(.*)$/.exec(line);
        if (bullet !== null) {
          return (
            <div key={key} className="flex gap-2 pl-1">
              <span aria-hidden="true">•</span>
              <span className="min-w-0">{renderTokens(parseInline(bullet[1] ?? ''), key)}</span>
            </div>
          );
        }
        if (line.trim() === '') return <div key={key} className="h-2" />;
        return <div key={key}>{renderTokens(parseInline(line), key)}</div>;
      })}
    </>
  );
}

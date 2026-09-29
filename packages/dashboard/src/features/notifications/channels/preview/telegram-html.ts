/** @module features/notifications/channels/preview/telegram-html — parses the HTML subset of Telegram's `parse_mode: HTML`, and (with `rich`) the block tags of Rich Messages (headings, paragraphs, tables, lists, footers, rules, media), into a small tree the mock renders as React nodes; never `innerHTML`. Unknown tags and malformed markup stay visible as text, as Telegram would refuse them. */

/** A node of the parsed message. */
export type TgNode =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'el';
      readonly tag: TgTag;
      readonly href?: string;
      readonly expandable?: boolean;
      readonly language?: string;
      /** `<tg-time unix=…>`: the moment, shown in the reader's time zone. */
      readonly unix?: number;
      /** `<h1>`…`<h6>`. */
      readonly level?: number;
      /** `<img src>` (rich): the media reference (`tg://photo?id=shot`). */
      readonly src?: string;
      /** `<table bordered>` / `compact` (rich). */
      readonly bordered?: boolean;
      readonly compact?: boolean;
      readonly children: readonly TgNode[];
    };

/** Tags Telegram supports in HTML mode (aliases folded). */
export type TgTag =
  | 'b'
  | 'i'
  | 'u'
  | 's'
  | 'code'
  | 'pre'
  | 'a'
  | 'blockquote'
  | 'spoiler'
  | 'time'
  | 'emoji'
  // Rich Message blocks (D-40)
  | 'h'
  | 'p'
  | 'br'
  | 'hr'
  | 'img'
  | 'table'
  | 'tr'
  | 'td'
  | 'th'
  | 'ul'
  | 'ol'
  | 'li'
  | 'footer'
  | 'figure'
  | 'figcaption';

const ALIASES: Readonly<Record<string, TgTag>> = {
  b: 'b',
  strong: 'b',
  i: 'i',
  em: 'i',
  u: 'u',
  ins: 'u',
  s: 's',
  strike: 's',
  del: 's',
  code: 'code',
  pre: 'pre',
  a: 'a',
  blockquote: 'blockquote',
  'tg-spoiler': 'spoiler',
  'tg-time': 'time',
  'tg-emoji': 'emoji',
};

/** Block tags Rich Messages add (Bot API 10.1). */
const RICH: Readonly<Record<string, TgTag>> = {
  h1: 'h',
  h2: 'h',
  h3: 'h',
  h4: 'h',
  h5: 'h',
  h6: 'h',
  p: 'p',
  br: 'br',
  hr: 'hr',
  img: 'img',
  table: 'table',
  tr: 'tr',
  td: 'td',
  th: 'th',
  ul: 'ul',
  ol: 'ol',
  li: 'li',
  footer: 'footer',
  figure: 'figure',
  figcaption: 'figcaption',
};

/** Tags without content or a closing tag. */
const VOID: ReadonlySet<TgTag> = new Set(['br', 'hr', 'img']);

const NAMED: Readonly<Record<string, string>> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Decodes the HTML entities Telegram accepts (named subset and numeric). */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED[body.toLowerCase()] ?? match;
  });
}

interface Frame {
  readonly tag: TgTag | null;
  readonly name: string;
  readonly attrs: Readonly<Record<string, string | true>>;
  readonly children: TgNode[];
}

function parseAttrs(raw: string): Record<string, string | true> {
  const attrs: Record<string, string | true> = {};
  for (const m of raw.matchAll(/([a-zA-Z_:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    const name = (m[1] ?? '').toLowerCase();
    const value = m[2] ?? m[3] ?? m[4];
    attrs[name] = value === undefined ? true : decodeEntities(value);
  }
  return attrs;
}

function pushText(frame: Frame, text: string): void {
  if (text === '') return;
  const last = frame.children.at(-1);
  if (last !== undefined && last.type === 'text') {
    frame.children[frame.children.length - 1] = { type: 'text', text: last.text + text };
  } else {
    frame.children.push({ type: 'text', text });
  }
}

function close(frame: Frame): TgNode {
  if (frame.tag === null) return { type: 'text', text: '' };
  const base = { type: 'el' as const, tag: frame.tag, children: frame.children };
  if (frame.tag === 'a') {
    const href = frame.attrs['href'];
    return { ...base, ...(typeof href === 'string' && { href }) };
  }
  if (frame.tag === 'blockquote')
    return { ...base, expandable: frame.attrs['expandable'] !== undefined };
  if (frame.tag === 'time') {
    const unix = Number(frame.attrs['unix']);
    return Number.isFinite(unix) ? { ...base, unix } : base;
  }
  if (frame.tag === 'h') return { ...base, level: Number(frame.name.slice(1)) || 3 };
  if (frame.tag === 'img') {
    const src = frame.attrs['src'];
    return { ...base, ...(typeof src === 'string' && { src }) };
  }
  if (frame.tag === 'table') {
    return {
      ...base,
      bordered: frame.attrs['bordered'] !== undefined,
      compact: frame.attrs['compact'] !== undefined,
    };
  }
  if (frame.tag === 'code') {
    const cls = frame.attrs['class'];
    if (typeof cls === 'string' && cls.startsWith('language-')) {
      return { ...base, language: cls.slice('language-'.length) };
    }
  }
  return base;
}

/**
 * Parses Telegram HTML into nodes. `<span class="tg-spoiler">` is a spoiler; tags outside the
 * subset, stray closing tags and unclosed tags are kept as literal text.
 */
export function parseTelegramHtml(
  html: string,
  options: { readonly rich?: boolean } = {},
): readonly TgNode[] {
  const rich = options.rich === true;
  const root: Frame = { tag: null, name: '#root', attrs: {}, children: [] };
  const stack: Frame[] = [root];
  const top = () => stack[stack.length - 1] ?? root;
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^<>]*?)?)\s*(\/?)>/g;
  let last = 0;
  for (let m = re.exec(html); m !== null; m = re.exec(html)) {
    pushText(top(), decodeEntities(html.slice(last, m.index)));
    last = m.index + m[0].length;
    const closing = m[1] === '/';
    const name = (m[2] ?? '').toLowerCase();
    const attrs = parseAttrs(m[3] ?? '');
    let tag: TgTag | undefined = ALIASES[name] ?? (rich ? RICH[name] : undefined);
    if (name === 'span' && attrs['class'] === 'tg-spoiler') tag = 'spoiler';
    if (name === 'span' && closing) {
      const open = [...stack].reverse().find((f) => f.name === 'span');
      if (open !== undefined) tag = 'spoiler';
    }
    if (tag === undefined) {
      pushText(top(), m[0]);
      continue;
    }
    if (!closing && VOID.has(tag)) {
      top().children.push(close({ tag, name, attrs, children: [] }));
      continue;
    }
    if (closing && VOID.has(tag)) continue;
    if (!closing) {
      stack.push({ tag, name, attrs, children: [] });
      continue;
    }
    const index = stack.map((f) => f.name).lastIndexOf(name);
    if (index <= 0) {
      pushText(top(), m[0]);
      continue;
    }
    while (stack.length > index) {
      const frame = stack.pop();
      if (frame === undefined) break;
      const node = close(frame);
      top().children.push(node);
    }
  }
  pushText(top(), decodeEntities(html.slice(last)));
  while (stack.length > 1) {
    const frame = stack.pop();
    if (frame === undefined) break;
    top().children.push(close(frame));
  }
  return root.children;
}

/** The plain text of nodes (tests, the ntfy-like fallbacks). */
export function tgText(nodes: readonly TgNode[]): string {
  return nodes.map((n) => (n.type === 'text' ? n.text : tgText(n.children))).join('');
}

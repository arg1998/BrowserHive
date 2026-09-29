/** @module features/notifications/channels/preview/telegram-html.test — the Telegram HTML subset parser: tags and aliases, links, expandable quotes, entities, and malformed markup kept as text */
import { describe, expect, it } from 'bun:test';
import { decodeEntities, parseTelegramHtml, tgText } from './telegram-html.ts';

describe('parseTelegramHtml', () => {
  it('parses the supported tags, aliases and attributes', () => {
    const nodes = parseTelegramHtml(
      '⚠️ <b>Attention</b> <strong>now</strong>\n<i>x</i><code>id</code><a href="https://bh.example.net/s?live=1">Open</a><blockquote expandable>quote</blockquote>',
    );
    expect(nodes.map((n) => (n.type === 'el' ? n.tag : 'text'))).toEqual([
      'text',
      'b',
      'text',
      'b',
      'text',
      'i',
      'code',
      'a',
      'blockquote',
    ]);
    const link = nodes[7];
    expect(link?.type === 'el' && link.href).toBe('https://bh.example.net/s?live=1');
    const quote = nodes[8];
    expect(quote?.type === 'el' && quote.expandable).toBe(true);
  });

  it('decodes entities and never turns text into markup', () => {
    expect(tgText(parseTelegramHtml('a &lt;script&gt; &amp; b &#39;c&#39; &#x1F600;'))).toBe(
      "a <script> & b 'c' 😀",
    );
    const nodes = parseTelegramHtml('<script>alert(1)</script>');
    expect(nodes).toEqual([{ type: 'text', text: '<script>alert(1)</script>' }]);
  });

  it('keeps stray and unclosed tags readable', () => {
    expect(tgText(parseTelegramHtml('x</b> y'))).toBe('x</b> y');
    const unclosed = parseTelegramHtml('<b>bold');
    expect(unclosed[0]?.type === 'el' && unclosed[0].tag).toBe('b');
  });

  it('reads pre/code languages and spoilers', () => {
    const [pre] = parseTelegramHtml('<pre><code class="language-json">{}</code></pre>');
    const code = pre?.type === 'el' ? pre.children[0] : undefined;
    expect(code?.type === 'el' && code.language).toBe('json');
    const [spoiler] = parseTelegramHtml('<span class="tg-spoiler">s</span>');
    expect(spoiler?.type === 'el' && spoiler.tag).toBe('spoiler');
  });

  it('decodes the named entity subset', () => {
    expect(decodeEntities('&quot;&nbsp;&unknown;')).toBe('" &unknown;');
  });
});

describe('tg-time', () => {
  it('keeps the unix time of a <tg-time> tag', () => {
    const [node] = parseTelegramHtml('<tg-time unix="1700000000" format="t">14:13 UTC</tg-time>');
    expect(node?.type === 'el' && node.tag).toBe('time');
    expect(node?.type === 'el' && node.unix).toBe(1_700_000_000);
  });
});

describe('discord timestamps', () => {
  it('parses <t:unix:style> as a time token', async () => {
    const { parseInline } = await import('./discord-markdown.tsx');
    expect(parseInline('since <t:1700000000:t> ok')).toEqual([
      { t: 'text', v: 'since ' },
      { t: 'time', unix: 1_700_000_000, style: 't' },
      { t: 'text', v: ' ok' },
    ]);
    expect(parseInline('**b** `c` [x](https://a.b) \\*')).toEqual([
      { t: 'b', c: [{ t: 'text', v: 'b' }] },
      { t: 'text', v: ' ' },
      { t: 'code', v: 'c' },
      { t: 'text', v: ' ' },
      { t: 'link', label: [{ t: 'text', v: 'x' }], href: 'https://a.b' },
      { t: 'text', v: ' *' },
    ]);
  });
});

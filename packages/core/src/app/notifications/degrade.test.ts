/** @module app/notifications/degrade.test — `degrade()` and `restrictContent()` table-driven (D-32): tables → lists, images dropped or linked, act → open, duplicate links, button cap, plain text, truncation with the "Open in BrowserHive" footer, content levels. */

import { describe, expect, it } from 'bun:test';
import {
  type Block,
  type NotificationMessage as Message,
  NotificationMessage,
} from '@browserhive/contracts/notifications';
import { capabilities } from '../../../test/helpers/fake-channel.ts';
import { restrictContent } from './content-level.ts';
import { degrade, OPEN_IN_BROWSERHIVE, sparkline } from './degrade.ts';
import { buildMessage, code, link, text } from './message.ts';

const TABLE: Block = {
  type: 'table',
  columns: ['Tool', 'Errors'],
  rows: [
    [[code('click')], [text('3')]],
    [[code('navigate')], [text('1')]],
  ],
};
const IMAGE: Block = {
  type: 'image',
  ref: 'shot-1',
  alt: 'Login page',
  captured_at: 5,
  masked: true,
  path: '/sessions/shop-a1b2c3d4?tab=screenshots',
};
const IMAGE_NO_PAGE: Block = { ...IMAGE, path: null };

function message(overrides: Partial<Parameters<typeof buildMessage>[0]> = {}): Message {
  return buildMessage({
    id: 'n-000000000001',
    revision: 1,
    thread: 'attention:a-000000000001',
    kind: 'attention.requested',
    severity: 'warn',
    state: 'open',
    alert: true,
    createdAt: 1,
    updatedAt: 1,
    title: 'Attention requested',
    summary: 'captcha — agent blocked',
    blocks: [
      { type: 'quote', content: [text('please solve the captcha')], collapsible: true },
      {
        type: 'fields',
        items: [{ label: 'Session', value: [link('shop', '/sessions/shop-a1b2c3d4')] }],
      },
    ],
    actions: [
      {
        kind: 'open',
        id: 'take-over',
        label: 'Take over',
        style: 'primary',
        path: '/sessions/shop-a1b2c3d4?live=1&takeover=1',
      },
      {
        kind: 'act',
        id: 'resolve',
        label: 'Mark resolved',
        style: 'default',
        command: {
          op: 'attention.resolve',
          args: { request_id: 'a-000000000001', decision: 'resolve' },
        },
        confirm: null,
        fallback: { label: 'Open in BrowserHive', path: '/sessions/shop-a1b2c3d4?live=1' },
      },
      {
        kind: 'act',
        id: 'reject',
        label: 'Reject',
        style: 'danger',
        command: {
          op: 'attention.resolve',
          args: { request_id: 'a-000000000001', decision: 'reject' },
        },
        confirm: 'Reject?',
        fallback: { label: 'Open in BrowserHive', path: '/sessions/shop-a1b2c3d4?live=1' },
      },
    ],
    entities: { session_id: 'shop-a1b2c3d4', session_slug: 'shop', request_id: 'a-000000000001' },
    ...overrides,
  });
}

describe('degrade', () => {
  it('keeps everything a capable channel supports', () => {
    const full = capabilities({ tables: true, actButtons: true, maxButtons: 5 });
    const m = message({ blocks: [TABLE, IMAGE] });
    const out = degrade(m, full);
    expect(out.blocks).toEqual([TABLE, IMAGE]);
    expect(out.actions).toEqual(m.actions);
    expect(out.privacy.has_image).toBe(true);
    expect(NotificationMessage.safeParse(out).success).toBe(true);
  });

  it('turns a table into a list of column: value rows', () => {
    const out = degrade(message({ blocks: [TABLE] }), capabilities({ tables: false }));
    expect(out.blocks[0]).toMatchObject({ type: 'list', ordered: false });
    expect(JSON.stringify(out.blocks[0])).toContain('"Tool:"');
    expect(out.blocks[0]?.type === 'list' && out.blocks[0].items).toHaveLength(2);
  });

  it('drops an image, or links to its page, where images are unsupported', () => {
    const out = degrade(
      message({ blocks: [IMAGE, IMAGE_NO_PAGE] }),
      capabilities({ images: false }),
    );
    expect(out.blocks).toEqual([
      {
        type: 'text',
        content: [link('View screenshot', '/sessions/shop-a1b2c3d4?tab=screenshots')],
      },
    ]);
    expect(out.privacy.has_image).toBe(false);
  });

  it('replaces act buttons by their open fallback once, and caps the buttons', () => {
    const out = degrade(message(), capabilities({ actButtons: false, maxButtons: 5 }));
    expect(out.actions.map((a) => [a.kind, a.id])).toEqual([
      ['open', 'take-over'],
      ['open', 'resolve'],
    ]);
    const capped = degrade(message(), capabilities({ actButtons: true, maxButtons: 2 }));
    expect(capped.actions.map((a) => a.id)).toEqual(['take-over', 'resolve']);
  });

  it('never shows an act button outside the open state', () => {
    const resolved = { ...message(), state: 'resolved' as const };
    const out = degrade(resolved, capabilities({ actButtons: true, maxButtons: 5 }));
    expect(out.actions.every((a) => a.kind === 'open')).toBe(true);
  });

  it('flattens rich blocks into paragraphs for plain-text channels', () => {
    const out = degrade(
      message({
        blocks: [{ type: 'heading', text: 'Details' }, ...message().blocks, { type: 'divider' }],
      }),
      capabilities({ richBlocks: false }),
    );
    expect(out.blocks.every((b) => b.type === 'text')).toBe(true);
    expect(JSON.stringify(out.blocks)).toContain('"Session:"');
  });

  it('moves the first link into a footer where link buttons are unsupported', () => {
    const out = degrade(message(), capabilities({ openLinks: false, actButtons: false }));
    expect(out.actions).toEqual([]);
    expect(out.blocks.at(-1)).toEqual({
      type: 'footer',
      content: [link(OPEN_IN_BROWSERHIVE, '/sessions/shop-a1b2c3d4?live=1&takeover=1')],
    });
  });

  it('clips the title and cuts blocks past the text budget with an Open in BrowserHive footer', () => {
    const long = message({
      title: 'T'.repeat(100),
      blocks: [
        { type: 'text', content: [text('a'.repeat(50))] },
        { type: 'text', content: [text('b'.repeat(500))] },
      ],
    });
    const out = degrade(long, capabilities({ maxTitleChars: 20, maxTextChars: 120 }));
    expect(out.title).toHaveLength(20);
    expect(out.title.endsWith('…')).toBe(true);
    expect(out.blocks.at(-1)).toEqual({
      type: 'footer',
      content: [text('… '), link(OPEN_IN_BROWSERHIVE, '/sessions/shop-a1b2c3d4?live=1&takeover=1')],
    });
    expect(JSON.stringify(out.blocks)).not.toContain('bbbb');
    expect(NotificationMessage.safeParse(out).success).toBe(true);
  });

  it('does not modify its input', () => {
    const m = message({ blocks: [TABLE, IMAGE] });
    const copy = structuredClone(m);
    degrade(m, capabilities({ tables: false, images: false, richBlocks: false, maxTextChars: 10 }));
    expect(m).toEqual(copy);
  });
});

describe('restrictContent', () => {
  it('full is unchanged', () => {
    const m = message();
    expect(restrictContent(m, 'full')).toBe(m);
  });

  it('titles keeps title, summary, fields and footers only', () => {
    const out = restrictContent(message({ blocks: [...message().blocks, IMAGE, TABLE] }), 'titles');
    expect(out.blocks.map((b) => b.type)).toEqual(['fields']);
    expect(out.title).toBe('Attention requested');
    expect(out.summary).toBe('captcha — agent blocked');
    expect(out.privacy).toEqual({ level: 'titles', has_image: false });
  });

  it('counts keeps the kind label, the group count and the session slug', () => {
    const out = restrictContent(
      message({ kind: 'tool.errors', title: 'shop · 7 tool errors', summary: 'click · X' }),
      'counts',
    );
    expect(out.title).toBe('Tool errors (7)');
    expect(out.summary).toBe('Session shop');
    expect(out.blocks).toEqual([]);
    expect(out.entities).toEqual({ session_id: 'shop-a1b2c3d4', session_slug: 'shop' });
    expect(out.privacy.level).toBe('counts');
  });

  it('never raises a message above the level it already has', () => {
    const counts = restrictContent(message(), 'counts');
    expect(restrictContent(counts, 'full')).toEqual(counts);
  });
});

describe('charts (D-32, spec 03 §9.2)', () => {
  const CHART: Block = {
    type: 'chart',
    label: 'Tool calls per hour',
    values: [0, 2, 4, 8],
    start: 0,
    step_ms: 3_600_000,
    unit: 'calls',
  };

  it('scales text bars against the largest value; all zero is flat', () => {
    expect(sparkline([0, 2, 4, 8])).toBe('▁▃▅█');
    expect(sparkline([0, 0, 0])).toBe('▁▁▁');
    expect(sparkline([5])).toBe('█');
  });

  it('turns a chart into one paragraph where charts are not a capability', () => {
    const out = degrade(message({ blocks: [CHART] }), capabilities({ charts: false }));
    expect(out.blocks).toEqual([
      {
        type: 'text',
        content: [
          { type: 'bold', text: 'Tool calls per hour' },
          { type: 'text', text: ' ' },
          { type: 'code', text: '▁▃▅█' },
          { type: 'text', text: ' peak\u00a08\u00a0calls' },
        ],
      },
    ]);
    expect(NotificationMessage.safeParse(out).success).toBe(true);
  });

  it('keeps a chart where charts render natively (the generic webhook)', () => {
    const out = degrade(message({ blocks: [CHART] }), capabilities({ charts: true }));
    expect(out.blocks).toEqual([CHART]);
  });
});

describe('restrictContent of a report built at its level', () => {
  it('returns a message already at the target level unchanged (tables kept at titles)', () => {
    const built = {
      ...message({ blocks: [TABLE] }),
      privacy: { level: 'titles', has_image: false },
    };
    expect(restrictContent(built as Message, 'titles')).toBe(built as Message);
    expect(restrictContent(built as Message, 'counts').blocks).toEqual([]);
  });
});

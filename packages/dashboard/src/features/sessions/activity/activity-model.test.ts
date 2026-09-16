/** @module features/sessions/activity/activity-model.test — unique ids, folding a navigation's page visit into its tool call, fetch kinds, descriptions without repeated text, event time format, merge dedupe by id */
import { describe, expect, it } from 'bun:test';
import {
  attentionItem,
  eid,
  pageItem,
  T0,
  toolCallDetail,
  toolItem,
} from '../../../../test/fixtures/sessions.ts';
import { visibleResult } from './ActivityDetail.tsx';
import {
  buildEntries,
  describeEntry,
  eventTime,
  fetchKinds,
  isErrorItem,
  itemId,
  toggleKind,
  toolIcon,
} from './activity-model.ts';
import { mergeTimeline } from './use-activity-feed.ts';

describe('activity model', () => {
  it('keys rows by the unique timeline id, never the shared event id', () => {
    const tool = toolItem(1);
    const page = pageItem(1);
    expect(itemId(tool)).not.toBe(itemId(page));
    expect(mergeTimeline([tool, page], [page, toolItem(2)]).map(itemId)).toEqual([
      itemId(tool),
      itemId(page),
      itemId(toolItem(2)),
    ]);
  });

  it('folds a page visit into the tool call that produced it when tools are shown', () => {
    const items = [toolItem(1), pageItem(1), pageItem(5, { title: null })];
    const all = buildEntries(items, undefined);
    expect(all.map((e) => e.id)).toEqual([itemId(toolItem(1)), itemId(pageItem(5))]);
    expect(all[0]?.landed?.url).toBe('https://example.com/page-1');
    const toolsOnly = buildEntries(items, ['tool']);
    expect(toolsOnly.map((e) => e.item.kind)).toEqual(['tool']);
    expect(toolsOnly[0]?.landed).toBeDefined();
    const pagesOnly = buildEntries(items, ['page']);
    expect(pagesOnly.map((e) => e.item.kind)).toEqual(['page', 'page']);
    expect(fetchKinds(['tool'])).toEqual(['page', 'tool']);
    expect(fetchKinds(['attention', 'vault'])).toEqual(['attention', 'vault']);
    expect(fetchKinds(undefined)).toBeUndefined();
    expect(toggleKind(['tool'], 'tool')).toBeUndefined();
    expect(toggleKind(undefined, 'page')).toEqual(['page']);
  });

  it('describes rows without repeating the tool name or error code', () => {
    const failed = {
      id: 't',
      item: toolItem(2, { ok: false, error_code: 'TIMEOUT', error_message: 'took too long' }),
    };
    const d = describeEntry(failed);
    expect(d.primary).toBe('navigate');
    expect(d.secondary).toEqual({ type: 'error', code: 'TIMEOUT', message: 'took too long' });
    expect(d.status).toEqual({ label: 'TIMEOUT', tone: 'danger' });
    expect(isErrorItem(failed.item)).toBe(true);
    const [nav] = buildEntries([toolItem(1), pageItem(1)], undefined);
    expect(nav !== undefined && describeEntry(nav).secondary).toEqual({
      type: 'url',
      url: 'https://example.com/page-1',
      note: 'Example page 1',
    });
    const page = describeEntry({ id: 'p', item: pageItem(3, { title: '  ' }) });
    expect(page.primary).toBe('example.com');
    expect(isErrorItem(pageItem(3))).toBe(false);
  });

  it('formats event times as HH:MM:SS with the date only when not today', () => {
    const today = eventTime(T0 - 5_000, T0);
    expect(today.clock).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(today.date).toBeUndefined();
    expect(eventTime(T0 - 3 * 86_400_000, T0).date).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
  });

  it('folds a request_attention call into its attention row, which shows the outcome and reply', () => {
    const ask = toolItem(7, { tool: 'request_attention', ts: T0 - 30_000, duration_ms: 90_000 });
    const linked = attentionItem({ event_id: eid(7), status: 'resolved', message: 'Solved it.' });
    const entries = buildEntries([linked, ask, toolItem(8)], undefined);
    expect(entries.map((e) => e.item.kind)).toEqual(['attention', 'tool']);
    expect(entries[0]?.call?.tool).toBe('request_attention');
    const d = entries[0] === undefined ? null : describeEntry(entries[0]);
    expect(d?.badge).toEqual({ label: 'resolved', tone: 'success' });
    expect(d?.secondary).toEqual({ type: 'text', text: '“Solved it.”' });
    // No event id: the nearest call within a few seconds is the one that asked.
    const unlinked = attentionItem({ event_id: null, created_at: T0 - 29_000 });
    expect(buildEntries([unlinked, ask], undefined).map((e) => e.item.kind)).toEqual(['attention']);
    // Tools only: the call stays visible.
    expect(buildEntries([linked, ask], ['tool']).map((e) => e.item.kind)).toEqual(['tool']);
    const pending = describeEntry({ id: 'a', item: attentionItem() });
    expect(pending.secondary).toEqual({
      type: 'text',
      text: 'A CAPTCHA blocks the login form. Please solve it.',
    });
  });

  it('gives common tools their own icon and leaves successful rows without a status label', () => {
    expect(toolIcon('navigate')).toBe('toolNavigate');
    expect(toolIcon('click')).toBe('toolClick');
    expect(toolIcon('screenshot')).toBe('toolScreenshot');
    expect(toolIcon('something_new')).toBe('tool');
    expect(describeEntry({ id: 't', item: toolItem(1) }).status.label).toBe('');
    expect(describeEntry({ id: 'p', item: pageItem(1) }).status.label).toBe('');
  });

  it('drops a failed call result that only echoes the error', () => {
    const failed = { ok: false, error_code: 'TIMEOUT', error_message: 'took too long' } as const;
    expect(visibleResult({ ...failed, result_text: '[TIMEOUT] took too long' })).toBeNull();
    expect(visibleResult({ ...failed, result_text: '{"partial":true}' })).toBe('{"partial":true}');
    expect(visibleResult({ ...toolCallDetail(1), result_text: '{"ok":true}' })).toBe('{"ok":true}');
    expect(visibleResult({ ...toolCallDetail(1), result_text: '  ' })).toBeNull();
  });
});

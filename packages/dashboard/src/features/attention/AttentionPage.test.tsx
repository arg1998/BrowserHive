/** @module features/attention/AttentionPage.test — board render + axe (takeover deep link, isolated tickers), resolve (optimistic, message sent and echoed), reject behind a confirm, live insertion from `attention.created`, history facet counts and row expansion, history filters in the URL, card helpers */
import { describe, expect, it } from 'bun:test';
import { keys } from '@/lib/api/keys.ts';
import { expectNoA11yViolations } from '../../../test/helpers/axe.ts';
import { envelope, renderPage } from '../../../test/helpers/page-harness.tsx';
import { act, fireEvent, screen, waitFor, within } from '../../../test/helpers/render.tsx';
import { choicesOf, takeoverHref } from './AttentionCard.tsx';
import { AttentionPage } from './AttentionPage.tsx';
import { sentMessageDescription } from './api.ts';
import { requestRow } from './fixtures.ts';
import { facetOptions } from './HistoryTable.tsx';
import { captureOffset } from './RequestThumbnail.tsx';
import { attentionSearch } from './search.ts';

function setup(url = '/attention') {
  let pending = [
    requestRow(),
    requestRow({ request_id: 'a-BBBBBBBBBBBB', reason: 'Approve the 2FA prompt', mode: 'notify' }),
  ];
  const settled = [
    requestRow({
      request_id: 'a-CCCCCCCCCCCC',
      reason: 'Old one',
      status: 'resolved',
      resolved_by: 'admin',
      waited_ms: 5000,
      message: 'done',
    }),
  ];
  const cacheDuringResolve: unknown[] = [];
  const harness = renderPage({
    path: '/attention',
    component: AttentionPage,
    validateSearch: (s) => attentionSearch.parse(s),
    url,
    routes: {
      'GET /system': { vault: { enabled: false, backend: null } },
      'GET /me/preferences': { preferences: {}, updated_at: null },
      'GET /attention': (req: { query: URLSearchParams }) =>
        req.query.get('status') === 'pending'
          ? envelope(pending, { open_count: pending.length })
          : envelope(settled, {
              open_count: pending.length,
              facets: {
                status: [{ value: 'resolved', count: 1 }],
                mode: [{ value: 'takeover', count: 1 }],
              },
            }),
      'GET /sessions/shop-ab12cd34/screenshots': envelope([]),
      'POST /attention/a-AAAAAAAAAAAA/resolve': () => {
        cacheDuringResolve.push(harness.client.getQueryData(keys.attention.pending()));
        pending = pending.filter((p) => p['request_id'] !== 'a-AAAAAAAAAAAA');
        return { ok: true, status: 'resolved' };
      },
      'POST /attention/a-BBBBBBBBBBBB/resolve': () => {
        pending = pending.filter((p) => p['request_id'] !== 'a-BBBBBBBBBBBB');
        return { ok: true, status: 'rejected' };
      },
    },
  });
  return { ...harness, cacheDuringResolve, setPending: (rows: typeof pending) => (pending = rows) };
}

describe('AttentionPage', () => {
  it('renders the board with decision-grade payload and history, axe clean', async () => {
    const { container } = setup();
    const card = await screen.findByRole('article', { name: 'Solve the CAPTCHA' });
    expect(within(card).getByText('Waiting 1m 00s')).toBeTruthy();
    expect(within(card).getByText('10m 00s left')).toBeTruthy();
    expect(within(card).getAllByText('Take over').length).toBe(2);
    expect(
      within(card)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['a', 'b']);
    expect(within(card).getByRole('link', { name: 'Take over' }).getAttribute('href')).toBe(
      '/sessions/shop-ab12cd34?live=1&takeover=1',
    );
    const notify = screen.getByRole('article', { name: 'Approve the 2FA prompt' });
    expect(within(notify).getByRole('link', { name: 'Open session' })).toBeTruthy();
    // The explainer lives once in the header, never per card; no duplicate "Attention" heading.
    expect(screen.queryByText(/lease is frozen while it waits/)).toBeNull();
    expect(screen.getAllByRole('heading', { name: /^Attention/ }).length).toBe(1);
    const history = await screen.findByRole('region', { name: 'Settled requests' });
    expect(within(history).getByText('Old one')).toBeTruthy();
    expect(within(history).getByText('“done”')).toBeTruthy();
    // The open count is shown once (header pill), never again as a section count.
    expect(screen.getByText('2 open')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Open requests' }).textContent).toBe(
      'Open requests',
    );
    // Phone order: the primary action first, Reject last.
    const takeoverLink = within(card).getByRole('link', { name: 'Take over' });
    const resolveButton = within(card).getByRole('button', { name: 'Resolve' });
    const rejectButton = within(card).getByRole('button', { name: 'Reject' });
    const follows = (a: Element, b: Element) =>
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect(follows(takeoverLink, resolveButton) && follows(resolveButton, rejectButton)).toBe(true);
    // Shared DataTable puts aria-expanded on the <tr> of expandable rows (reported in the B2 handoff).
    await expectNoA11yViolations(container);
  });

  it('shows API facet counts on the history chips and expands a row on click', async () => {
    setup();
    const resolved = await screen.findByRole('button', { name: /Resolved\s*1/ });
    expect(resolved.textContent).toContain('1');
    expect(screen.getByRole('button', { name: /Rejected\s*0/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Take over\s*1/ })).toBeTruthy();
    const history = await screen.findByRole('region', { name: 'Settled requests' });
    const row = within(history).getByText('Old one').closest('tr');
    if (row === null) throw new Error('history row missing');
    expect(row.getAttribute('aria-expanded')).toBe('false');
    await act(async () => {
      fireEvent.click(row);
    });
    await waitFor(() => expect(row.getAttribute('aria-expanded')).toBe('true'));
    expect(within(history).getByText('Message to agent')).toBeTruthy();
    // The phone card of the same request shares the expansion.
    const cards = screen.getByRole('list', { name: 'Settled requests' });
    expect(within(cards).getByText('Message to agent')).toBeTruthy();
  });

  it('resolves optimistically with the drafted message', async () => {
    const { requests, cacheDuringResolve } = setup();
    const card = await screen.findByRole('article', { name: 'Solve the CAPTCHA' });
    fireEvent.change(within(card).getByLabelText('Message back to agent'), {
      target: { value: 'solved it' },
    });
    await act(async () => {
      fireEvent.click(within(card).getByRole('button', { name: 'Resolve' }));
    });
    await waitFor(() =>
      expect(screen.queryByRole('article', { name: 'Solve the CAPTCHA' })).toBeNull(),
    );
    const post = requests.find((r) => r.method === 'POST' && r.path.includes('/attention/'));
    expect(post?.body).toEqual({ decision: 'resolve', message: 'solved it' });
    const snapshot = cacheDuringResolve[0] as { data: { request_id: string }[] };
    expect(snapshot.data.map((r) => r.request_id)).toEqual(['a-BBBBBBBBBBBB']);
  });

  it('asks for confirmation before rejecting', async () => {
    const { requests } = setup();
    const card = await screen.findByRole('article', { name: 'Approve the 2FA prompt' });
    await act(async () => {
      fireEvent.click(within(card).getByRole('button', { name: 'Reject' }));
    });
    const dialog = await screen.findByRole('alertdialog');
    expect(requests.some((r) => r.method === 'POST' && r.path.includes('/attention/'))).toBe(false);
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Reject' }));
    });
    await waitFor(() =>
      expect(
        requests.find((r) => r.method === 'POST' && r.path.includes('/attention/'))?.body,
      ).toEqual({ decision: 'reject' }),
    );
  });

  it('inserts a card live from attention.created', async () => {
    const harness = setup();
    await screen.findByRole('article', { name: 'Solve the CAPTCHA' });
    await act(async () => {
      harness.connect();
    });
    const created = requestRow({ request_id: 'a-DDDDDDDDDDDD', reason: 'Pick the right account' });
    await act(async () => {
      harness.emit('attention', { type: 'attention.created', request: created });
    });
    expect(await screen.findByRole('article', { name: 'Pick the right account' })).toBeTruthy();
  });

  it('filters by session from the URL and keeps history filters in the query', async () => {
    const { requests } = setup('/attention?session=other-zz99zz99&mode=notify&status=rejected');
    await waitFor(() => expect(screen.getByText('Queue clear')).toBeTruthy());
    const history = requests.find(
      (r) => r.path.endsWith('/attention') && r.query.get('status') !== 'pending',
    );
    expect(history?.query.get('mode')).toBe('notify');
    expect(history?.query.get('status')).toBe('rejected');
    expect(history?.query.get('session_id')).toBe('other-zz99zz99');
    expect(
      attentionSearch.parse({ status: 'rejected,bogus', mode: 'takeover', session: 'NOT AN ID' }),
    ).toMatchObject({
      // csv params drop only the invalid values.
      status: ['rejected'],
      mode: ['takeover'],
      session: undefined,
      page: 1,
    });
  });
});

describe('attention helpers', () => {
  it('builds links, choices, offsets, facets and the sent-message echo', () => {
    expect(takeoverHref('shop-ab12cd34')).toBe('/sessions/shop-ab12cd34?live=1&takeover=1');
    expect(choicesOf({ choices: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(choicesOf({ choices: ['a'], other: 1 })).toBeNull();
    expect(choicesOf({ choices: [1] })).toBeNull();
    expect(captureOffset(1_000, 61_000)).toBe('1m 00s before the request');
    expect(captureOffset(61_500, 61_000)).toBe('at the request');
    expect(captureOffset(73_000, 61_000)).toBe('12s after the request');
    expect(facetOptions([{ value: 'resolved', count: 3 }], ['resolved', 'rejected'])).toEqual([
      { value: 'resolved', count: 3 },
      { value: 'rejected', count: 0 },
    ]);
    expect(sentMessageDescription('  ')).toBeUndefined();
    expect(sentMessageDescription('solved it')).toBe('Message sent: “solved it”');
    expect(sentMessageDescription('x'.repeat(200))?.length).toBeLessThan(140);
  });
});

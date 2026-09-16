/** @module features/logs/LogsPage.test — newest-first seed, live records on top, Live toggle pressed state holding and flushing records, level filters on the request and the tail, reconnect gap fill with `after_seq` (no wipe), older pages by cursor, ErrorState instead of an endless skeleton, runtime log level popover, axe clean */

import { describe, expect, it } from 'bun:test';
import type { LogRecord } from '@browserhive/contracts/http';
import { logRecord, systemConfig } from '../../../test/fixtures/ops.ts';
import { expectNoA11yViolations } from '../../../test/helpers/axe.ts';
import { problem, type RecordedRequest, renderPage } from '../../../test/helpers/page-harness.tsx';
import { act, fireEvent, screen, waitFor, within } from '../../../test/helpers/render.tsx';
import { LogsPage } from './LogsPage.tsx';
import { logsSearch } from './search.ts';

function logsPage(data: readonly LogRecord[], nextCursor: string | null = null) {
  return {
    data: [...data],
    page: { next_cursor: nextCursor, limit: 200 },
    applied: { filters: {}, sort: { key: 'seq', dir: 'desc' } },
    meta: { now: 1_700_000_000_000 },
    latest_seq: data[0]?.seq ?? 0,
  };
}

interface Options {
  readonly url?: string;
  readonly logs?: (req: RecordedRequest) => unknown;
}

function mount({ url = '/logs', logs }: Options = {}) {
  return renderPage({
    path: '/logs',
    component: LogsPage,
    validateSearch: (s) => logsSearch.parse(s),
    routes: {
      'GET /logs':
        logs ??
        ((req: RecordedRequest) => {
          if (req.query.get('cursor') === 'older-1')
            return logsPage([logRecord(1, { msg: 'the oldest record' })]);
          if (req.query.get('after_seq') !== null)
            return logsPage([logRecord(9, { msg: 'missed while offline' })]);
          return logsPage(
            [
              logRecord(3, { level: 'warn', msg: 'lease nearly expired', trace_id: 'abc123' }),
              logRecord(2),
            ],
            'older-1',
          );
        }),
      'GET /system/config': systemConfig(),
      'PATCH /system/log-level': (req: { body: unknown }) => ({
        ok: true,
        effective: (req.body as { spec: string }).spec,
      }),
    },
    url,
  });
}

const log = () => screen.getByRole('log', { name: 'Log records' });
const messages = () =>
  within(log())
    .getAllByRole('button', { expanded: false })
    .map((b) => b.textContent ?? '');

async function connected(view: ReturnType<typeof mount>) {
  await waitFor(() => expect(view.sockets.length).toBeGreaterThan(0));
  act(() => {
    view.connect();
  });
}

describe('LogsPage', () => {
  it('shows the newest record first and puts live records on top', async () => {
    const view = mount();
    await screen.findByText('lease nearly expired');
    expect(messages()[0]).toContain('lease nearly expired');
    expect(messages()[1]).toContain('record 2');
    const call = view.requests.find((r) => r.path === '/api/v1/logs');
    expect(call?.query.get('dir')).toBe('desc');
    await connected(view);
    act(() => {
      view.emit('logs', { type: 'log.record', record: logRecord(4, { msg: 'tail arrived' }) });
    });
    await within(log()).findByText('tail arrived');
    expect(messages()[0]).toContain('tail arrived');
    await expectNoA11yViolations(view.container);
  });

  it('expands a record on click with its trace filter and fields', async () => {
    mount();
    const row = (await screen.findByText('lease nearly expired')).closest('button');
    if (row === null) throw new Error('row button missing');
    fireEvent.click(row);
    expect(row.getAttribute('aria-expanded')).toBe('true');
    const filter = await screen.findByRole('link', { name: /Filter to trace/ });
    expect(filter.getAttribute('href')).toContain('trace_id=abc123');
    expect(screen.getByRole('link', { name: /Open trace in APM/ }).getAttribute('href')).toBe(
      'https://apm.test/trace/abc123',
    );
  });

  it('Live pauses the tail and reads Resume while paused; resuming flushes held records', async () => {
    const view = mount();
    await screen.findByText('lease nearly expired');
    await connected(view);
    fireEvent.click(screen.getByRole('button', { name: /^Live/ }));
    const resumeTail = await screen.findByRole('button', { name: 'Resume the live tail' });
    expect(resumeTail.textContent).toContain('Resume');
    act(() => {
      view.emit('logs', { type: 'log.record', record: logRecord(5, { msg: 'held back' }) });
    });
    const resume = await screen.findByRole('button', { name: /1 new record/ });
    expect(within(log()).queryByText('held back')).toBeNull();
    // Still paused after the list re-rendered and measured.
    expect(screen.getByRole('button', { name: 'Resume the live tail' })).toBeTruthy();
    fireEvent.click(resume);
    await within(log()).findByText('held back');
    expect(await screen.findByRole('button', { name: /^Live/ })).toBeTruthy();
  });

  it('never flushes records queued under the previous filters into the new buffer', async () => {
    const view = mount({
      logs: (req) =>
        req.query.get('level') === 'warn'
          ? logsPage([])
          : logsPage([logRecord(3, { msg: 'seeded info' })]),
    });
    await screen.findByText('seeded info');
    await connected(view);
    const levels = screen.getByRole('group', { name: 'Level' });
    // The record passes the old (no level) filter and is batched; the filter changes before the flush.
    act(() => {
      view.emit('logs', { type: 'log.record', record: logRecord(4, { msg: 'queued info' }) });
      fireEvent.click(within(levels).getByRole('button', { name: 'warn' }));
    });
    await waitFor(() =>
      expect(view.router.state.location.search).toMatchObject({ level: ['warn'] }),
    );
    await screen.findByText('No records match these filters');
    // Well past the 100 ms flush.
    await act(() => new Promise((resolve) => setTimeout(resolve, 250)));
    expect(screen.queryByText('queued info')).toBeNull();
    expect(screen.queryByText(/received live/)).toBeNull();
    expect(screen.getByText('No records match these filters')).toBeTruthy();
  });

  it('hides dashboard traffic by default, counts it, and shows it on request', async () => {
    const access = (seq: number, patch: Partial<LogRecord>) =>
      logRecord(seq, {
        module: 'http.access',
        msg: 'request completed',
        method: 'GET',
        route_pattern: 'getMe',
        status: 200,
        duration_ms: 1,
        ...patch,
      });
    const view = mount({
      logs: () =>
        logsPage([
          access(6, {}),
          access(5, { route_pattern: 'listNotifications' }),
          access(4, { method: 'POST', route_pattern: 'deleteSession' }),
          access(3, { route_pattern: 'getSession', status: 404 }),
          access(2, { method: 'POST', route_pattern: '/mcp' }),
          logRecord(1, { msg: 'session closed' }),
        ]),
    });
    await screen.findByText('session closed');
    expect(within(log()).queryByText(/getMe/)).toBeNull();
    expect(within(log()).queryByText(/listNotifications/)).toBeNull();
    expect(within(log()).getByText(/deleteSession/)).toBeTruthy();
    expect(within(log()).getByText(/getSession/)).toBeTruthy();
    expect(within(log()).getByText(/\/mcp/)).toBeTruthy();
    expect(screen.getByText(/2 dashboard records hidden/)).toBeTruthy();
    // Hiding is a view filter: no refetch.
    const calls = view.requests.filter((r) => r.path === '/api/v1/logs').length;
    fireEvent.click(screen.getByRole('switch'));
    await within(log()).findByText(/getMe/);
    expect(view.router.state.location.search).toMatchObject({ dashboard: 'show' });
    expect(view.requests.filter((r) => r.path === '/api/v1/logs').length).toBe(calls);
    expect(screen.queryByText(/dashboard records? hidden/)).toBeNull();
  });

  it('shows every record of a request filter, dashboard traffic included', async () => {
    mount({
      url: '/logs?request_id=req-1',
      logs: () =>
        logsPage([
          logRecord(2, {
            module: 'http.access',
            method: 'GET',
            route_pattern: 'getMe',
            status: 200,
            request_id: 'req-1',
          }),
        ]),
    });
    await screen.findByText(/getMe/);
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('applies level filters to the request and to live records', async () => {
    const view = mount({ url: '/logs?level=warn' });
    await screen.findByText('lease nearly expired');
    const call = view.requests.find((r) => r.path === '/api/v1/logs');
    expect(call?.query.get('level')).toBe('warn');
    await connected(view);
    act(() => {
      view.emit('logs', { type: 'log.record', record: logRecord(5, { msg: 'info noise' }) });
      view.emit('logs', {
        type: 'log.record',
        record: logRecord(6, { level: 'warn', msg: 'warn signal' }),
      });
    });
    await within(log()).findByText('warn signal');
    expect(within(log()).queryByText('info noise')).toBeNull();
    const levels = screen.getByRole('group', { name: 'Level' });
    fireEvent.click(within(levels).getByRole('button', { name: 'error' }));
    await waitFor(() =>
      expect(view.router.state.location.search).toMatchObject({ level: ['warn', 'error'] }),
    );
  });

  it('fills the gap after a reconnect with after_seq and keeps what was shown', async () => {
    const view = mount();
    await screen.findByText('lease nearly expired');
    await connected(view);
    act(() => {
      view.emit('logs', { type: 'log.record', record: logRecord(7, { msg: 'before the drop' }) });
    });
    await within(log()).findByText('before the drop');
    act(() => {
      view.sockets[view.sockets.length - 1]?.serverClose(1006);
      view.timers.advance(10_000);
    });
    await waitFor(() => expect(view.sockets.length).toBe(2));
    act(() => {
      view.connect();
    });
    await within(log()).findByText('missed while offline');
    const gap = view.requests.find((r) => r.query.get('after_seq') !== null);
    expect(gap?.query.get('after_seq')).toBe('7');
    expect(within(log()).getByText('before the drop')).toBeTruthy();
    expect(within(log()).getByText('lease nearly expired')).toBeTruthy();
    expect(messages()[0]).toContain('missed while offline');
  });

  it('loads older records with the cursor', async () => {
    const view = mount();
    await screen.findByText('lease nearly expired');
    fireEvent.click(screen.getByRole('button', { name: 'Load older records' }));
    await within(log()).findByText('the oldest record');
    expect(view.requests.some((r) => r.query.get('cursor') === 'older-1')).toBe(true);
    expect(messages().at(-1)).toContain('the oldest record');
    expect(await screen.findByText('Start of the log buffer')).toBeTruthy();
  });

  it('shows the error instead of an endless skeleton', async () => {
    mount({ logs: () => problem(500, 'INTERNAL_ERROR', 'Internal error') });
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText('Internal error')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('sets the runtime log level from the header popover', async () => {
    const view = mount();
    const trigger = await screen.findByRole('button', { name: /Daemon log level/ });
    await waitFor(() => expect(trigger.textContent).toContain('info +1'));
    await act(async () => {
      fireEvent.pointerDown(trigger, { pointerType: 'mouse', button: 0 });
      fireEvent.mouseDown(trigger, { button: 0 });
      fireEvent.pointerUp(trigger, { pointerType: 'mouse', button: 0 });
      fireEvent.mouseUp(trigger, { button: 0 });
      fireEvent.click(trigger);
    });
    const form = await screen.findByRole('form', { name: 'Log level' });
    const module = within(form).getByRole('textbox', { name: 'Module 1' }) as HTMLInputElement;
    expect(module.value).toBe('sessions');
    fireEvent.change(module, { target: { value: 'Bad.Module' } });
    await act(async () => {
      fireEvent.click(within(form).getByRole('button', { name: 'Apply' }));
    });
    await within(form).findByRole('alert');
    expect(view.requests.some((r) => r.method === 'PATCH')).toBe(false);
    fireEvent.change(module, { target: { value: 'browsers' } });
    await act(async () => {
      fireEvent.click(within(form).getByRole('button', { name: 'Apply' }));
    });
    await waitFor(() => {
      const patch = view.requests.find((r) => r.method === 'PATCH');
      expect(patch?.body).toEqual({ spec: 'info,browsers=debug' });
    });
  });
});

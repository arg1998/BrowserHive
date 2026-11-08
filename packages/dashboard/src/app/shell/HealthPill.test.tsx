/** @module app/shell/HealthPill.test — the pill stays Live on an idle page, turns Degraded on a failed request and back on the next answer; the popover names the failure (issue #50) */
import { afterEach, describe, expect, it, setSystemTime } from 'bun:test';
import { networkError } from '@/lib/api/errors.ts';
import { renderPage } from '../../../test/helpers/page-harness.tsx';
import { act, fireEvent, screen, waitFor } from '../../../test/helpers/render.tsx';
import { HealthPill } from './HealthPill.tsx';

async function mount() {
  const harness = renderPage({
    path: '/',
    component: () => <HealthPill />,
    routes: {},
    url: '/',
  });
  await screen.findByRole('button', { name: /^Connection:/ });
  await waitFor(() => expect(harness.sockets.length).toBeGreaterThan(0));
  harness.connect();
  await screen.findByRole('button', { name: 'Connection: Live' });
  return harness;
}

describe('HealthPill', () => {
  afterEach(() => setSystemTime());

  it('stays Live with a connected socket and no requests for five minutes', async () => {
    const { client } = await mount();
    await act(() => client.fetchQuery({ queryKey: ['x'], queryFn: async () => 1 }));
    setSystemTime(new Date(Date.now() + 5 * 60_000));
    // Something touches the cache without a request (a page mounts a disabled query): still Live.
    await act(async () => {
      client.getQueryCache().build(client, { queryKey: ['disabled'] });
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: 'Connection: Live' })).toBeTruthy();
  });

  it('a failed request is Degraded; the next answer is Live again', async () => {
    const { client } = await mount();
    await act(() =>
      client
        .fetchQuery({ queryKey: ['x'], queryFn: () => Promise.reject(networkError(null)) })
        .catch(() => 0),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Connection: Degraded' }));
    expect(await screen.findByText('Failing (network error)')).toBeTruthy();
    await act(() => client.fetchQuery({ queryKey: ['y'], queryFn: async () => 1 }));
    expect(await screen.findByRole('button', { name: 'Connection: Live' })).toBeTruthy();
    expect(await screen.findByText('Healthy')).toBeTruthy();
    expect(screen.getByText('just now')).toBeTruthy();
  });

  it('while Degraded, the reachability watcher rechecks /health every 15 s; its answer clears it', async () => {
    const harness = await mount();
    const { client, timers, requests } = harness;
    await act(() =>
      client
        .fetchQuery({ queryKey: ['x'], queryFn: () => Promise.reject(networkError(null)) })
        .catch(() => 0),
    );
    await screen.findByRole('button', { name: 'Connection: Degraded' });
    const healthRequests = () => requests.filter((r) => r.path === '/health').length;
    expect(healthRequests()).toBe(0);
    act(() => timers.advance(15_000));
    // The fake daemon answers /health with a marked 404: any daemon answer clears the failure.
    expect(await screen.findByRole('button', { name: 'Connection: Live' })).toBeTruthy();
    expect(healthRequests()).toBe(1);
    act(() => timers.advance(60_000));
    expect(healthRequests()).toBe(1);
  });
});

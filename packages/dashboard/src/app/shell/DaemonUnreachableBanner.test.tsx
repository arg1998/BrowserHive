/** @module app/shell/DaemonUnreachableBanner.test — the banner appears only after 3 consecutive failed outage probes, a gap over 15 s resets the count, it takes the place of AuthRetryBanner, it clears on the first BrowserHive answer, its sentence goes to the permanent status region, and What to do shows the help (04 §18.7) */
import { describe, expect, it } from 'bun:test';
import { AuthProvider, useAuth } from '@/app/providers/AuthProvider.tsx';
import { networkError } from '@/lib/api/errors.ts';
import { DaemonReachabilityProvider } from '@/lib/daemon-help/reachability.tsx';
import type { OfflineReason, SocketStatus } from '@/lib/ws/store.ts';
import { expectNoA11yViolations } from '../../../test/helpers/axe.ts';
import { manualTimers } from '../../../test/helpers/manual-timers.ts';
import { fakeFetch, json } from '../../../test/helpers/page-harness.tsx';
import { act, fireEvent, render, screen } from '../../../test/helpers/render.tsx';
import {
  bannerText,
  DaemonUnreachableAnnouncer,
  ShellBanners,
} from './DaemonUnreachableBanner.tsx';

type Socket = { readonly status: SocketStatus; readonly reason: OfflineReason | null };

/** Puts the session check into its retrying state, as a failed `/auth/me` would. */
function FailSessionCheck() {
  const { dispatch } = useAuth();
  return (
    <button
      type="button"
      onClick={() =>
        dispatch({ type: 'probe.failed', error: networkError(null), delayMs: 600_000, at: 0 })
      }
    >
      fail session check
    </button>
  );
}

function mount() {
  const timers = manualTimers();
  let skew = 0;
  const env = { daemon: 'down' as 'down' | 'up' };
  let probes = 0;
  const { fetchImpl } = fakeFetch({});
  const probeFetch = (input: string) => {
    expect(input).toBe('/health');
    probes += 1;
    return env.daemon === 'up'
      ? Promise.resolve(json({ status: 'ready', version: '1.0.0' }))
      : Promise.reject(new TypeError('Failed to fetch'));
  };
  const tree = (socket: Socket) => (
    <AuthProvider fetch={fetchImpl}>
      <DaemonReachabilityProvider
        socket={socket}
        fetch={probeFetch}
        timers={timers}
        clock={() => timers.clock() + skew}
      >
        <header>topbar</header>
        <ShellBanners />
        <main>
          <p>page body</p>
          <FailSessionCheck />
        </main>
        <DaemonUnreachableAnnouncer />
      </DaemonReachabilityProvider>
    </AuthProvider>
  );
  const view = render(tree({ status: 'connected', reason: null }));
  return {
    ...view,
    env,
    probes: () => probes,
    setSocket: (socket: Socket) => act(() => view.rerender(tree(socket))),
    advance: (ms: number) => act(() => timers.advance(ms)),
    jump: (ms: number) => {
      skew += ms;
    },
    banner: () => screen.queryByTestId('daemon-unreachable-banner'),
    status: () => screen.getByTestId('daemon-unreachable-status').textContent,
  };
}

const OFFLINE: Socket = { status: 'offline', reason: 'network' };

describe('DaemonUnreachableBanner', () => {
  it('appears only after three consecutive failed probes, and announces once in the permanent region', async () => {
    const t = mount();
    await screen.findByText('page body');
    // The region exists, empty, before anything happens.
    expect(screen.getByRole('status').textContent).toBe('');
    t.setSocket(OFFLINE);
    await t.advance(0);
    await t.advance(5_000);
    expect(t.probes()).toBe(2);
    expect(t.banner()).toBeNull();
    expect(t.status()).toBe('');
    await t.advance(5_000);
    expect(t.probes()).toBe(3);
    const banner = t.banner();
    expect(banner?.textContent).toContain("Can't reach BrowserHive at localhost:9876.");
    expect(banner?.textContent).toContain('It may have stopped.');
    // The strip itself is not a live region: only the shell's status region speaks.
    expect(banner?.getAttribute('role')).toBeNull();
    expect(t.status()).toBe(bannerText(window.location.host));
    // Never modal: the page stays readable and nothing is inert.
    expect(screen.getByText('page body')).toBeTruthy();
    expect(document.querySelector('[inert]')).toBeNull();
    await expectNoA11yViolations(t.container);
  });

  it('a gap over 15 s between probes resets the count', async () => {
    const t = mount();
    await screen.findByText('page body');
    t.setSocket(OFFLINE);
    await t.advance(0);
    await t.advance(5_000);
    t.jump(16_000);
    await t.advance(5_000);
    expect(t.probes()).toBe(3);
    expect(t.banner()).toBeNull();
    await t.advance(10_000);
    expect(t.banner()).not.toBeNull();
  });

  it('takes the place of AuthRetryBanner while shown', async () => {
    const t = mount();
    await screen.findByText('page body');
    fireEvent.click(screen.getByRole('button', { name: 'fail session check' }));
    expect(await screen.findByText(/Retry now/)).toBeTruthy();
    t.setSocket(OFFLINE);
    await t.advance(0);
    await t.advance(10_000);
    expect(t.banner()).not.toBeNull();
    expect(screen.queryByText(/Retry now/)).toBeNull();
  });

  it('clears on the first BrowserHive answer, and the open dialog says it is back', async () => {
    const t = mount();
    await screen.findByText('page body');
    t.setSocket(OFFLINE);
    await t.advance(0);
    await t.advance(10_000);
    fireEvent.click(screen.getByRole('button', { name: 'What to do' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain("BrowserHive isn't running");
    expect(screen.getByRole('button', { name: 'Copy browserhive doctor' })).toBeTruthy();
    t.env.daemon = 'up';
    await t.advance(5_000);
    expect(t.banner()).toBeNull();
    expect(t.status()).toBe('');
    expect(screen.getByRole('dialog').textContent).toContain('BrowserHive is back');
  });

  it('clears when the socket connects again', async () => {
    const t = mount();
    await screen.findByText('page body');
    t.setSocket(OFFLINE);
    await t.advance(0);
    await t.advance(10_000);
    expect(t.banner()).not.toBeNull();
    t.setSocket({ status: 'connected', reason: null });
    await t.advance(0);
    expect(t.banner()).toBeNull();
  });

  it('What to do: the not-running body and every command with its own copy button', async () => {
    const t = mount();
    await screen.findByText('page body');
    t.setSocket(OFFLINE);
    await t.advance(0);
    await t.advance(10_000);
    fireEvent.click(screen.getByRole('button', { name: 'What to do' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Nothing is answering at localhost:9876.');
    for (const command of [
      'browserhive --admin',
      'bunx browserhive --admin',
      'browserhive doctor',
      'browserhive config show',
    ]) {
      expect(screen.getByRole('button', { name: `Copy ${command}` })).toBeTruthy();
    }
    expect(dialog.textContent).toContain('Start it the way you usually do.');
    const learn = screen.getByRole('link', { name: /Learn more/ });
    expect(learn.getAttribute('href')).toContain('the-app-says-browserhive-isnt-running');
    await expectNoA11yViolations(dialog);
  });
});

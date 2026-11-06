/** @module offline/page.test — the offline page in happy-dom, per state: heading and body, commands with copy buttons, Forget this address, focus order, theme, reload and loop guard, axe (04 §18.6, 09 §3.5) */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { LAST_SEEN_KEY, OFFLINE_RELOADS_KEY } from '@/lib/daemon-help/keys.ts';
import type { ProbeOutcome } from '@/lib/daemon-help/probe.ts';
import { docsUrl } from '@/lib/links.ts';
import { THEME_STORAGE_KEY } from '@/theme/resolve.ts';
import { expectNoA11yViolations } from '../../test/helpers/axe.ts';
import { type ManualTimers, manualTimers } from '../../test/helpers/manual-timers.ts';
import {
  FORGOTTEN_TEXT,
  mountOfflinePage,
  type OfflineLocation,
  type OfflinePage,
  type OfflineRegistration,
} from './page.ts';

const marked = (status: number, body: unknown): ProbeOutcome => ({
  kind: 'response',
  status,
  marked: true,
  body,
});
const OUTCOMES = {
  rejected: { kind: 'rejected' },
  timeout: { kind: 'timeout' },
  ready: marked(200, { status: 'ready', version: '0.3.0' }),
  starting: marked(200, { status: 'starting', version: '0.3.0' }),
  refused: marked(421, { error: { code: 'HOST_NOT_ALLOWED' } }),
  proxy: { kind: 'response', status: 502, marked: false, body: undefined },
  foreign: { kind: 'response', status: 200, marked: false, body: undefined },
} satisfies Record<string, ProbeOutcome>;

interface Harness {
  readonly root: HTMLElement;
  readonly timers: ManualTimers;
  readonly page: OfflinePage;
  readonly location: OfflineLocation & { readonly calls: string[] };
  readonly copied: string[];
  readonly unregistered: string[];
  readonly cacheNames: string[];
  readonly media: { matches: boolean; fire(): void };
  setOutcome(outcome: ProbeOutcome): void;
  setVisible(visible: boolean): void;
  probes(): number;
}

let harness: Harness | null = null;

interface SetupOptions {
  readonly outcome?: ProbeOutcome;
  readonly hostname?: string;
  readonly port?: string;
  readonly pathname?: string;
  readonly online?: boolean;
  readonly prefersDark?: boolean;
  readonly userAgent?: string;
}

function setup(options: SetupOptions = {}): Harness {
  const timers = manualTimers();
  const root = document.createElement('div');
  document.body.appendChild(root);
  let outcome: ProbeOutcome = options.outcome ?? OUTCOMES.rejected;
  let probes = 0;
  let visible = true;
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (visible ? 'visible' : 'hidden'),
  });
  const copied: string[] = [];
  Object.defineProperty(document, 'execCommand', {
    configurable: true,
    value: (command: string) => {
      const area = document.body.querySelector('textarea');
      if (command === 'copy' && area !== null) copied.push(area.value);
      return true;
    },
  });
  const hostname = options.hostname ?? '127.0.0.1';
  const port = options.port ?? '9877';
  const calls: string[] = [];
  const location = {
    protocol: 'http:',
    hostname,
    port,
    host: port === '' ? hostname : `${hostname}:${port}`,
    pathname: options.pathname ?? '/sessions',
    calls,
    reload: () => calls.push('reload'),
    replace: (url: string) => calls.push(`replace ${url}`),
  };
  const unregistered: string[] = [];
  const registrations: OfflineRegistration[] = [
    `http://${location.host}/`,
    `http://${location.host}/trace-viewer/`,
  ].map((scope) => ({
    scope,
    unregister: async () => {
      unregistered.push(scope);
      return true;
    },
  }));
  const cacheNames = ['bh-offline-aaaaaaaaaaaa', 'trace-viewer-cache'];
  const listeners = new Set<() => void>();
  const media = {
    matches: options.prefersDark ?? false,
    addEventListener: (_type: 'change', fn: () => void) => listeners.add(fn),
    removeEventListener: (_type: 'change', fn: () => void) => listeners.delete(fn),
    fire: () => {
      for (const fn of listeners) fn();
    },
  };
  const page = mountOfflinePage(
    {
      document,
      window,
      location,
      navigator: {
        onLine: options.online ?? true,
        userAgent:
          options.userAgent ?? 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0',
        serviceWorker: { getRegistrations: async () => registrations },
      },
      caches: {
        keys: async () => [...cacheNames],
        delete: async (name: string) => {
          const index = cacheNames.indexOf(name);
          if (index >= 0) cacheNames.splice(index, 1);
          return index >= 0;
        },
      },
      matchMedia: () => media,
      probe: async () => {
        probes += 1;
        return outcome;
      },
      timers,
      clock: timers.clock,
    },
    root,
  );
  harness = {
    root,
    timers,
    page,
    location,
    copied,
    unregistered,
    cacheNames,
    media,
    setOutcome: (next) => {
      outcome = next;
    },
    setVisible: (value) => {
      visible = value;
      document.dispatchEvent(new Event('visibilitychange'));
    },
    probes: () => probes,
  };
  return harness;
}

const h1 = (h: Harness) => h.root.querySelector('h1')?.textContent ?? '';
const bodyText = (h: Harness) => h.root.querySelector('h1 + p')?.textContent ?? '';
const codes = (h: Harness) =>
  [...h.root.querySelectorAll('li code')].map((code) => code.textContent ?? '');
const button = (h: Harness, name: RegExp) =>
  [...h.root.querySelectorAll('button')].find((b) =>
    name.test(b.getAttribute('aria-label') ?? b.textContent ?? ''),
  ) as HTMLButtonElement | undefined;
const live = (h: Harness) => h.root.querySelector('[role="status"]')?.textContent ?? '';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

afterEach(() => {
  harness?.page.dispose();
  harness?.root.remove();
  harness = null;
});

describe('offline page: states', () => {
  it('shows checking before the first probe returns, with an empty status region', () => {
    const h = setup();
    expect(h1(h)).toBe('Checking BrowserHive at 127.0.0.1:9877…');
    expect(live(h)).toBe('');
    expect(h.root.querySelector('main')).not.toBeNull();
    expect(h.root.querySelectorAll('h1')).toHaveLength(1);
  });

  it('not running on loopback: heading, body, every command with --port, a copy button each', async () => {
    const h = setup();
    await h.timers.flush();
    expect(h1(h)).toBe("BrowserHive isn't running");
    expect(bodyText(h)).toBe(
      'Nothing is answering at 127.0.0.1:9877. If you just started it, it may still be getting ready. This page reconnects by itself.',
    );
    expect(codes(h)).toEqual([
      'browserhive --admin --port 9877',
      'bunx browserhive --admin --port 9877',
      'browserhive doctor',
      'browserhive config show',
      "ss -ltnp 'sport = :9877'",
      'lsof -nP -iTCP:9877 -sTCP:LISTEN',
      'Get-NetTCPConnection -LocalPort 9877 -State Listen',
    ]);
    expect(h.root.querySelectorAll('li button')).toHaveLength(7);
    expect(live(h)).toBe("BrowserHive isn't running");
    expect(document.title).toBe("BrowserHive isn't running · BrowserHive");
  });

  it('not running on a remote host: other wording, the remote note, no --port and no port lines', async () => {
    const h = setup({ hostname: 'bh.example.com', port: '' });
    await h.timers.flush();
    expect(h1(h)).toBe("Can't reach BrowserHive");
    expect(bodyText(h)).toContain('Nothing answered at bh.example.com.');
    expect(h.root.textContent).toContain('Run these on the machine where BrowserHive runs.');
    expect(codes(h)).toEqual([
      'browserhive --admin',
      'bunx browserhive --admin',
      'browserhive doctor',
      'browserhive config show',
    ]);
  });

  it('device offline when navigator.onLine is false', async () => {
    const h = setup({ online: false });
    await h.timers.flush();
    expect(h1(h)).toBe('This device is offline');
    expect(bodyText(h)).toBe('Reconnect to the network. This page reconnects by itself.');
    expect(codes(h)).toEqual([]);
  });

  it('not responding after a probe timeout', async () => {
    const h = setup({ outcome: OUTCOMES['timeout'] });
    await h.timers.flush();
    expect(h1(h)).toBe("BrowserHive isn't responding");
    expect(bodyText(h)).toContain("accepted the connection but didn't answer within 5 seconds");
    expect(codes(h)).toHaveLength(7);
  });

  it('starting: no start commands', async () => {
    const h = setup({ outcome: OUTCOMES['starting'] });
    await h.timers.flush();
    expect(h1(h)).toBe('BrowserHive is starting');
    expect(codes(h)[0]).toBe('browserhive doctor');
    expect(codes(h).some((c) => c.includes('--admin'))).toBe(false);
  });

  it('proxy unreachable for an unmarked 5xx', async () => {
    const h = setup({ outcome: OUTCOMES['proxy'] });
    await h.timers.flush();
    expect(h1(h)).toBe('BrowserHive is unreachable behind 127.0.0.1:9877');
  });

  it('refused names the HTTP status and offers only config show', async () => {
    const h = setup({ outcome: OUTCOMES['refused'] });
    await h.timers.flush();
    expect(h1(h)).toBe('BrowserHive turned this request away');
    expect(bodyText(h)).toContain('(HTTP 421)');
    expect(bodyText(h)).toContain('--allowedHosts');
    expect(codes(h)).toEqual(['browserhive config show']);
  });

  it('foreign: no commands, Forget this address as a button beside Retry now', async () => {
    const h = setup({ outcome: OUTCOMES['foreign'] });
    await h.timers.flush();
    expect(h1(h)).toBe('Another program is using this address');
    expect(codes(h)).toEqual([]);
    const forget = [...h.root.querySelectorAll('button')].filter(
      (b) => b.textContent === 'Forget this address' && !b.hidden,
    );
    expect(forget).toHaveLength(1);
    expect(forget[0]?.parentElement).toBe(button(h, /Retry now/)?.parentElement ?? null);
  });

  it('the last-used line and the docs link', async () => {
    localStorage.setItem(
      LAST_SEEN_KEY,
      JSON.stringify({ version: '0.3.1', seen_at: Date.UTC(2026, 10, 5, 9, 0, 0) }),
    );
    const h = setup();
    await h.timers.flush();
    expect(h.root.textContent).toContain('You last used BrowserHive 0.3.1 here 3 hours ago.');
    expect(codes(h)[1]).toBe('bunx browserhive@0.3.1 --admin --port 9877');
    const link = h.root.querySelector('a');
    expect(link?.getAttribute('href')).toBe(docsUrl('troubleshootingNotRunning'));
  });

  it('omits the last-used line when the stored value is unreadable', async () => {
    localStorage.setItem(LAST_SEEN_KEY, '{"version":"$(rm -rf /)","seen_at":1}');
    const h = setup();
    await h.timers.flush();
    expect(h.root.textContent).not.toContain('You last used');
  });
});

describe('offline page: actions', () => {
  it('copy buttons copy the exact command and confirm', async () => {
    const h = setup();
    await h.timers.flush();
    const copy = h.root.querySelector<HTMLButtonElement>('li button');
    expect(copy?.getAttribute('aria-label')).toBe('Copy: Start with the dashboard');
    copy?.click();
    await h.timers.flush();
    expect(h.copied).toEqual(['browserhive --admin --port 9877']);
    expect(copy?.textContent).toBe('Copied');
    await h.timers.advance(1_500);
    expect(copy?.textContent).toBe('Copy');
  });

  it('Forget this address unregisters only the root worker and deletes only bh-offline-* caches', async () => {
    const h = setup();
    await h.timers.flush();
    const forget = button(h, /^Forget this address$/);
    forget?.click();
    await h.timers.flush();
    expect(h.unregistered).toEqual(['http://127.0.0.1:9877/']);
    expect(h.cacheNames).toEqual(['trace-viewer-cache']);
    expect(h.root.textContent).toContain(FORGOTTEN_TEXT);
    expect(document.activeElement?.textContent).toBe(FORGOTTEN_TEXT);
    expect(forget?.hidden).toBe(true);
  });

  it('Retry now probes at once', async () => {
    const h = setup();
    await h.timers.flush();
    expect(h.probes()).toBe(1);
    button(h, /Retry now/)?.click();
    await h.timers.flush();
    expect(h.probes()).toBe(2);
  });

  it('focus order: copy buttons, Retry now, the docs link, Forget this address', async () => {
    const h = setup({ outcome: OUTCOMES['refused'] });
    await h.timers.flush();
    const focusable = [...h.root.querySelectorAll<HTMLElement>('a[href], button')]
      .filter((el) => !el.hidden && el.closest('[hidden]') === null)
      .map((el) => el.getAttribute('aria-label') ?? el.textContent);
    expect(focusable).toEqual([
      'Copy: See the settings in effect (port, host, data dir)',
      'Retry now',
      'Learn more about this page',
      'Forget this address',
    ]);
  });

  it('the status line counts down without touching the status region', async () => {
    const h = setup();
    await h.timers.flush();
    const status = h.root.querySelector('[role="status"]')?.parentElement;
    expect(status?.textContent).toContain('Checking again in 1 s');
    expect(status?.textContent).toContain('Last checked');
    expect(live(h)).toBe("BrowserHive isn't running");
  });
});

describe('offline page: polling and reload', () => {
  it('reloads when BrowserHive is ready', async () => {
    const h = setup();
    await h.timers.flush();
    h.setOutcome(OUTCOMES.ready);
    await h.timers.advance(1_000);
    expect(h.location.calls).toEqual(['reload']);
    expect(sessionStorage.getItem(OFFLINE_RELOADS_KEY)).not.toBeNull();
  });

  it('opened directly as /offline.html, replaces itself with /', async () => {
    const h = setup({ outcome: OUTCOMES['ready'], pathname: '/offline.html' });
    await h.timers.flush();
    expect(h.location.calls).toEqual(['replace /']);
  });

  it('pauses while hidden and probes at once when visible again', async () => {
    const h = setup();
    await h.timers.flush();
    h.setVisible(false);
    await h.timers.advance(30_000);
    expect(h.probes()).toBe(1);
    h.setVisible(true);
    await h.timers.flush();
    expect(h.probes()).toBe(2);
  });

  it('probes at once on online', async () => {
    const h = setup();
    await h.timers.flush();
    window.dispatchEvent(new Event('online'));
    await h.timers.flush();
    expect(h.probes()).toBe(2);
  });

  it('loop guard: the third automatic reload within 60 s shows Reload instead', async () => {
    const now = Date.UTC(2026, 10, 5, 12, 0, 0);
    sessionStorage.setItem(OFFLINE_RELOADS_KEY, JSON.stringify([now - 20_000, now - 10_000]));
    const h = setup({ outcome: OUTCOMES['ready'] });
    await h.timers.flush();
    expect(h.location.calls).toEqual([]);
    expect(h1(h)).toBe("BrowserHive answers, but the dashboard didn't load");
    expect(bodyText(h)).toBe('Reload, or restart BrowserHive.');
    const reload = button(h, /^Reload$/);
    reload?.click();
    expect(h.location.calls).toEqual(['reload']);
  });

  it('old reloads fall out of the 60 s window', async () => {
    const now = Date.UTC(2026, 10, 5, 12, 0, 0);
    sessionStorage.setItem(OFFLINE_RELOADS_KEY, JSON.stringify([now - 70_000, now - 10_000]));
    const h = setup({ outcome: OUTCOMES['ready'] });
    await h.timers.flush();
    expect(h.location.calls).toEqual(['reload']);
  });

  it('never reloads by itself when sessionStorage is unusable', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      get: () => {
        throw new Error('blocked');
      },
    });
    try {
      const h = setup({ outcome: OUTCOMES['ready'] });
      await h.timers.flush();
      expect(h.location.calls).toEqual([]);
      expect(button(h, /^Reload$/)).toBeDefined();
    } finally {
      if (original !== undefined) Object.defineProperty(globalThis, 'sessionStorage', original);
    }
  });
});

describe('offline page: theme', () => {
  it('always sets data-theme from the stored preference and the OS setting, and follows changes', async () => {
    const h = setup({ prefersDark: true });
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    h.media.matches = false;
    h.media.fire();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('a stored preference wins over the OS', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    setup({ prefersDark: true });
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });
});

describe('offline page: accessibility', () => {
  const states: [string, SetupOptions][] = [
    ['checking', { outcome: { kind: 'timeout' } }],
    ['not-running', {}],
    ['remote', { hostname: 'bh.example.com', port: '' }],
    ['starting', { outcome: OUTCOMES['starting'] }],
    ['refused', { outcome: OUTCOMES['refused'] }],
    ['foreign', { outcome: OUTCOMES['foreign'] }],
    ['loop-guard', { outcome: OUTCOMES['ready'], pathname: '/' }],
  ];
  for (const theme of ['light', 'dark'] as const) {
    it.each(states)(`%s passes axe (${theme})`, async (name, options) => {
      if (name === 'loop-guard') {
        const now = Date.UTC(2026, 10, 5, 12, 0, 0);
        sessionStorage.setItem(OFFLINE_RELOADS_KEY, JSON.stringify([now - 2_000, now - 1_000]));
      }
      localStorage.setItem(THEME_STORAGE_KEY, theme);
      const h = setup(options);
      if (name !== 'checking') await h.timers.flush();
      expect(document.documentElement.getAttribute('data-theme')).toBe(theme);
      await expectNoA11yViolations(h.root);
    });
  }
});

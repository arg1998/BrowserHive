/** @module features/install/install-app.test — Install app (04 §18.8.4): the account menu item and the palette action show for every kind but `standalone`; a held offer calls `prompt()` and opens no dialog; every other kind opens `InstallAppDialog` (one render per kind, axe); `InstallToastBridge` toasts on `installed` */
// The DOM first: Base UI's menu and portals read `document` when their modules load.
import '../../../test/setup.ts';
import { describe, expect, it } from 'bun:test';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { AuthProvider } from '@/app/providers/AuthProvider.tsx';
import { CommandPalette } from '@/app/shell/CommandPalette.tsx';
import { INSTALLED_TOAST, InstallToastBridge } from '@/app/shell/InstallToastBridge.tsx';
import { PrincipalMenu } from '@/app/shell/PrincipalMenu.tsx';
import { ToastStack } from '@/app/shell/ToastStack.tsx';
import { InstallPromptStore, type PromptTarget } from '@/lib/install/prompt-store.ts';
import type { InstallInput, InstallKind } from '@/lib/install/support.ts';
import { expectNoA11yViolations } from '../../../test/helpers/axe.ts';
import { fakeFetch } from '../../../test/helpers/page-harness.tsx';
import { act, fireEvent, render, screen, waitFor } from '../../../test/helpers/render.tsx';
import { InstallAppProvider } from './install-app.tsx';

const UA = {
  chrome:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0',
  android:
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36',
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1',
  firefoxWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:157.0) Gecko/20100101 Firefox/157.0',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:157.0) Gecko/20100101 Firefox/157.0',
  firefoxMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:157.0) Gecko/20100101 Firefox/157.0',
  safari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15',
  other: 'SomeBrowser/1.0',
} as const;

/** The browser input that yields each kind. */
const INPUTS: { readonly [K in InstallKind]: Partial<InstallInput> } = {
  standalone: { standalone: true, userAgent: UA.chrome },
  insecure: { secure: false, userAgent: UA.chrome },
  prompt: { hasPrompt: true, userAgent: UA.chrome },
  ios: { userAgent: UA.iphone, maxTouchPoints: 5 },
  'chromium-android': { userAgent: UA.android },
  chromium: { userAgent: UA.chrome },
  'firefox-windows': { userAgent: UA.firefoxWin },
  'firefox-linux': { userAgent: UA.firefoxLinux },
  'firefox-unsupported': { userAgent: UA.firefoxMac },
  'safari-macos': { userAgent: UA.safari },
  unknown: { userAgent: UA.other },
};
const KINDS = Object.keys(INPUTS) as InstallKind[];

function readerFor(kind: InstallKind) {
  return (hasPrompt: boolean): InstallInput => ({
    hasPrompt: hasPrompt || INPUTS[kind].hasPrompt === true,
    standalone: false,
    secure: true,
    userAgent: '',
    uaBrands: [],
    uaPlatform: null,
    maxTouchPoints: 0,
    ...INPUTS[kind],
  });
}

function fakeWindow() {
  return new EventTarget() as EventTarget & PromptTarget;
}

function offer() {
  const calls = { prompt: 0 };
  const event = Object.assign(new Event('beforeinstallprompt'), {
    platforms: ['web'],
    userChoice: Promise.resolve({ outcome: 'dismissed' as const, platform: 'web' }),
    prompt: async () => {
      calls.prompt += 1;
    },
  });
  return { event: event as BeforeInstallPromptEvent, calls };
}

const LOCATION = { protocol: 'http:', port: '9876', origin: 'http://localhost:9876' };

function mount(
  kind: InstallKind,
  ui: (children: ReactNode) => ReactNode = (c) => c,
  store = new InstallPromptStore(fakeWindow()),
) {
  const { fetchImpl } = fakeFetch({});
  const root = createRootRoute({
    component: () => (
      <InstallAppProvider store={store} readInput={readerFor(kind)} location={LOCATION}>
        {ui(<PrincipalMenu onOpenKeyboardMap={() => undefined} />)}
      </InstallAppProvider>
    ),
    staticData: { title: 'T' },
  });
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  const view = render(
    <AuthProvider fetch={fetchImpl}>
      <RouterProvider router={router} />
    </AuthProvider>,
  );
  return { ...view, store };
}

async function openMenu() {
  const trigger = await screen.findByRole('button', { name: /Account:/ });
  await act(async () => {
    fireEvent.click(trigger);
  });
  await screen.findByRole('menuitem', { name: /Log out/ });
}

describe('Install app in the account menu', () => {
  it.each(KINDS)(
    '%s: shown unless standalone, between Keyboard shortcuts and Log out',
    async (kind) => {
      mount(kind);
      await openMenu();
      const items = screen.getAllByRole('menuitem').map((i) => i.textContent?.trim() ?? '');
      if (kind === 'standalone') {
        expect(items.some((i) => i.startsWith('Install app'))).toBe(false);
        return;
      }
      const at = items.findIndex((i) => i.startsWith('Install app'));
      expect(items[at - 1]).toStartWith('Keyboard shortcuts');
      expect(items[at + 1]).toStartWith('Log out');
    },
  );

  it('a held offer: prompt() is called and no dialog of ours opens', async () => {
    const win = fakeWindow();
    const { event, calls } = offer();
    win.__bhInstallPrompt = event;
    mount('chromium', undefined, new InstallPromptStore(win));
    await openMenu();
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: /Install app/ }));
    });
    expect(calls.prompt).toBe(1);
    expect(screen.queryByRole('dialog', { name: 'Install BrowserHive' })).toBeNull();
  });
});

const DIALOG_TEXT: { readonly [K in Exclude<InstallKind, 'standalone' | 'prompt'>]: string[] } = {
  insecure: [
    'Browsers install apps only from a secure address.',
    'http://127.0.0.1:9876',
    'browserhive config show',
    'How to set a public address',
  ],
  ios: ['Tap Share, then Add to Home Screen.'],
  'chromium-android': ['Open the browser menu ⋮ and choose Add to Home screen or Install app.'],
  chromium: [
    'Google Chrome',
    'Click the install icon at the right of the address bar, or open the ⋮ menu › Cast, save, and share › Install page as app….',
    'Already installed? Your browser shows an Open in app button in the address bar instead.',
  ],
  'firefox-windows': ['Click the web-apps icon in the address bar, then Add to taskbar.'],
  'firefox-linux': [
    "Firefox on Linux doesn't install websites as apps unless that is turned on.",
    'Open this address in Chrome, Edge or another Chromium browser to install BrowserHive, or bookmark it here.',
    'http://localhost:9876',
  ],
  'firefox-unsupported': [
    "Firefox can't install websites as apps on this system.",
    'http://localhost:9876',
  ],
  'safari-macos': [
    'In the menu bar choose File › Add to Dock. Then open the new app once while BrowserHive is running: from then on it can show you help when BrowserHive is stopped.',
  ],
  unknown: [
    "Look for Install or Add to Home screen in your browser's menu. If there isn't one, this browser can't install websites as apps.",
  ],
};

describe('InstallAppDialog', () => {
  it.each(Object.keys(DIALOG_TEXT) as (keyof typeof DIALOG_TEXT)[])('%s', async (kind) => {
    mount(kind);
    await openMenu();
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: /Install app/ }));
    });
    const dialog = await screen.findByRole('dialog', { name: 'Install BrowserHive' });
    const text = (dialog.textContent ?? '').replace(/\s+/g, ' ');
    for (const expected of DIALOG_TEXT[kind]) expect(text).toContain(expected);
    expect(screen.getByRole('link', { name: /Learn more/ }).getAttribute('href')).toContain(
      'guide/dashboard/#install-as-an-app',
    );
    expect(screen.getAllByRole('button', { name: 'Close' }).length).toBe(1);
    await expectNoA11yViolations(dialog);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('Edge gets its own steps', async () => {
    const root = createRootRoute({
      component: () => (
        <InstallAppProvider
          store={new InstallPromptStore(fakeWindow())}
          readInput={(hasPrompt) => ({ ...readerFor('chromium')(hasPrompt), userAgent: UA.edge })}
          location={LOCATION}
        >
          <PrincipalMenu />
        </InstallAppProvider>
      ),
      staticData: { title: 'T' },
    });
    render(
      <AuthProvider fetch={fakeFetch({}).fetchImpl}>
        <RouterProvider
          router={createRouter({
            routeTree: root,
            history: createMemoryHistory({ initialEntries: ['/'] }),
          })}
        />
      </AuthProvider>,
    );
    await openMenu();
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: /Install app/ }));
    });
    const dialog = await screen.findByRole('dialog', { name: 'Install BrowserHive' });
    expect(dialog.textContent).toContain('Microsoft Edge');
    expect(dialog.textContent).toContain('Install this site as an app');
  });
});

describe('Install app in the command palette', () => {
  it.each(KINDS)('%s: the action follows the menu item', async (kind) => {
    mount(kind, (children) => (
      <>
        {children}
        <CommandPalette open onOpenChange={() => undefined} />
      </>
    ));
    const input = await screen.findByRole('combobox');
    await act(async () => {
      fireEvent.change(input, { target: { value: 'taskbar' } });
    });
    if (kind === 'standalone') {
      await waitFor(() => expect(screen.queryAllByRole('option').length).toBe(0));
      return;
    }
    await waitFor(() =>
      expect(screen.getByRole('option', { name: /Install BrowserHive as an app/ })).toBeTruthy(),
    );
  });

  it('runs the same handler: the dialog for this browser', async () => {
    mount('firefox-linux', (children) => (
      <>
        {children}
        <CommandPalette open onOpenChange={() => undefined} />
      </>
    ));
    const input = await screen.findByRole('combobox');
    await act(async () => {
      fireEvent.change(input, { target: { value: 'pwa' } });
    });
    const option = await screen.findByRole('option', { name: /Install BrowserHive as an app/ });
    await act(async () => {
      fireEvent.click(option);
    });
    const dialog = await screen.findByRole('dialog', { name: 'Install BrowserHive' });
    expect(dialog.getAttribute('data-install-kind')).toBe('firefox-linux');
  });
});

describe('InstallToastBridge', () => {
  it('toasts once per appinstalled', async () => {
    const win = fakeWindow();
    mount(
      'chromium',
      (children) => (
        <>
          {children}
          <InstallToastBridge />
          <ToastStack />
        </>
      ),
      new InstallPromptStore(win),
    );
    await screen.findByRole('button', { name: /Account:/ });
    expect(screen.queryByText(INSTALLED_TOAST.title)).toBeNull();
    await act(async () => {
      win.dispatchEvent(new Event('appinstalled'));
    });
    // The toast card (portal) and its status-region copy both carry the title.
    expect((await screen.findAllByText(INSTALLED_TOAST.title)).length).toBeGreaterThan(0);
  });
});

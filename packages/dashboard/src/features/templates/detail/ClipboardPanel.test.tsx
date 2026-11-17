/** @module features/templates/detail/ClipboardPanel.test — "Deny clipboard writes" on the Settings tab (spec 13 §2.1, D18): off by default with what it protects; turning it on saves `deny_clipboard_writes` with If-Match and says sites can tell; the Sites tab's Device-bound badge (spec 13 §2.3, §11.4) only on a device-bound site; axe clean in each state */
import { describe, expect, it } from 'bun:test';
import {
  hostView,
  signedInSite,
  templateDetail,
  tid,
} from '../../../../test/fixtures/templates.ts';
import { expectNoA11yViolations } from '../../../../test/helpers/axe.ts';
import { renderPage } from '../../../../test/helpers/page-harness.tsx';
import { act, fireEvent, screen, waitFor, within } from '../../../../test/helpers/render.tsx';
import { templatePageSearch } from '../search.ts';
import { DEVICE_BOUND_HINT } from './DeviceBoundBadge.tsx';
import { TemplatePage } from './TemplatePage.tsx';

const ID = tid(1);
const AXE = { disable: ['aria-hidden-focus'] } as const;

function mount(routes: Record<string, unknown>, url: string) {
  return renderPage({
    path: '/templates/$id',
    component: TemplatePage,
    validateSearch: (s) => templatePageSearch.parse(s),
    routes: {
      'GET /system': { vault: { enabled: false, backend: null } },
      'GET /sessions': { data: [], page: { next_cursor: null, limit: 100 } },
      ...routes,
    },
    url,
  });
}

describe('Settings tab: Deny clipboard writes', () => {
  it('is off by default and explains what it protects; axe clean', async () => {
    const view = mount(
      { [`GET /templates/${ID}`]: templateDetail({ version: 4 }) },
      `/templates/${ID}?tab=settings`,
    );
    const toggle = await screen.findByRole('switch', { name: 'Deny clipboard writes' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    const panel = toggle.closest('section') as HTMLElement;
    expect(
      within(panel).getByText(/A page an agent clicks can put its own text on your clipboard/),
    ).toBeDefined();
    expect(within(panel).getByText(/pages already open are fully covered after/)).toBeDefined();
    expect(within(panel).queryByText('Restart the browser for full effect')).toBeNull();
    expect(within(panel).queryByText(/Sites can tell/)).toBeNull();
    await expectNoA11yViolations(view.container, AXE);
  });

  it('turning it on saves with If-Match; on, it says sites can tell; axe clean', async () => {
    const view = mount(
      {
        [`GET /templates/${ID}`]: templateDetail({ version: 4 }),
        [`PATCH /templates/${ID}`]: {
          template: templateDetail({ version: 5, deny_clipboard_writes: true }).template,
          closed_sessions: [],
        },
      },
      `/templates/${ID}?tab=settings`,
    );
    const toggle = await screen.findByRole('switch', { name: 'Deny clipboard writes' });
    await act(async () => {
      fireEvent.click(toggle);
    });
    await waitFor(() => expect(view.requests.some((r) => r.method === 'PATCH')).toBe(true));
    const patch = view.requests.find((r) => r.method === 'PATCH');
    expect(patch?.body).toEqual({ deny_clipboard_writes: true });
    expect(patch?.headers.get('if-match')).toBe('4');
    expect((await screen.findAllByText('Clipboard writes denied')).length).toBeGreaterThan(0);
    view.unmount();

    const on = mount(
      { [`GET /templates/${ID}`]: templateDetail({ deny_clipboard_writes: true }) },
      `/templates/${ID}?tab=settings`,
    );
    const onToggle = await screen.findByRole('switch', { name: 'Deny clipboard writes' });
    expect(onToggle.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('On: pages can’t write your clipboard')).toBeDefined();
    expect(screen.getByText(/Sites can tell/)).toBeDefined();
    await expectNoA11yViolations(on.container, AXE);
  });
});

describe('Settings tab: a change pages already open need a restart for', () => {
  const needsRestart = (deny: boolean) =>
    templateDetail(
      { deny_clipboard_writes: deny },
      { host: hostView({ state: 'running', clipboard_needs_restart: true }) },
    );

  it('turned on: says open pages could still write it and restarts the browser; axe clean', async () => {
    const view = mount(
      {
        [`GET /templates/${ID}`]: needsRestart(true),
        [`POST /templates/${ID}/host/restart`]: { host: hostView({ state: 'starting' }) },
      },
      `/templates/${ID}?tab=settings`,
    );
    const callout = (await screen.findByText('Restart the browser for full effect')).closest(
      '[role="note"]',
    ) as HTMLElement;
    expect(
      within(callout).getByText(/Pages that were already open could still write your clipboard/),
    ).toBeDefined();
    await expectNoA11yViolations(view.container, AXE);
    await act(async () => {
      fireEvent.click(within(callout).getByRole('button', { name: 'Restart browser' }));
    });
    await waitFor(() =>
      expect(
        view.requests.some((r) => r.method === 'POST' && r.path.endsWith('/host/restart')),
      ).toBe(true),
    );
  });

  it('turned off: says open pages keep refusing to copy until they reload', async () => {
    const view = mount(
      { [`GET /templates/${ID}`]: needsRestart(false) },
      `/templates/${ID}?tab=settings`,
    );
    expect(
      await screen.findByText(/Pages that were already open keep refusing to copy/),
    ).toBeDefined();
    await expectNoA11yViolations(view.container, AXE);
  });
});

describe('Sites tab: Device-bound', () => {
  it('badges only the device-bound site, with what it means; axe clean', async () => {
    const view = mount(
      {
        [`GET /templates/${ID}`]: templateDetail({
          sites: [
            { ...signedInSite('linkedin.com'), device_bound: true },
            signedInSite('indeed.com'),
          ],
        }),
      },
      `/templates/${ID}`,
    );
    const bound = (await screen.findByRole('heading', { level: 2, name: 'linkedin.com' })).closest(
      'section',
    ) as HTMLElement;
    const other = screen
      .getByRole('heading', { level: 2, name: 'indeed.com' })
      .closest('section') as HTMLElement;
    expect(within(bound).getByText('Device-bound')).toBeDefined();
    expect(within(bound).getByText(`: ${DEVICE_BOUND_HINT}`)).toBeDefined();
    expect(within(other).queryByText('Device-bound')).toBeNull();
    await expectNoA11yViolations(view.container, AXE);
  });
});

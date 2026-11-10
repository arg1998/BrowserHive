/** @module features/templates/detail/TemplatePage.test — the template page: header, banners and the six tabs over fake routes; axe on every tab; versions on a server without them; delete with the typed name; removing an unlisted sign-in; `?tab=` in the URL */
import { describe, expect, it } from 'bun:test';
import { sessionSummary, sessionsPage } from '../../../../test/fixtures/sessions.ts';
import {
  templateDetail,
  tid,
  versionRow,
  versionsPage,
} from '../../../../test/fixtures/templates.ts';
import { expectNoA11yViolations } from '../../../../test/helpers/axe.ts';
import { problem, renderPage } from '../../../../test/helpers/page-harness.tsx';
import { act, fireEvent, screen, waitFor, within } from '../../../../test/helpers/render.tsx';
import { templatePageSearch } from '../search.ts';
import { TemplatePage } from './TemplatePage.tsx';

const ID = tid(1);

function mount(url: string, routes: Record<string, unknown> = {}) {
  return renderPage({
    path: '/templates/$id',
    component: TemplatePage,
    validateSearch: (s) => templatePageSearch.parse(s),
    routes: {
      [`GET /templates/${ID}`]: templateDetail(),
      'GET /sessions': sessionsPage([
        sessionSummary(1, {
          template: { template_id: ID, name: 'job-hunt', version: null, mode: 'live' },
          sealed: true,
        }),
        sessionSummary(2, {
          slug: 'recording',
          template: { template_id: ID, name: 'job-hunt', version: null, mode: 'maintenance' },
        }),
      ]),
      [`GET /templates/${ID}/versions`]: versionsPage([versionRow(2), versionRow(1)]),
      'GET /system': { vault: { enabled: false, backend: null } },
      ...routes,
    },
    url,
  });
}

describe('TemplatePage', () => {
  it('renders the header, the six tabs and a card per site; axe clean', async () => {
    const view = mount(`/templates/${ID}`);
    await screen.findByRole('heading', { level: 1, name: 'Job hunt' });
    expect(screen.getByText('job-hunt')).toBeDefined();
    const tabs = screen.getByRole('tablist', { name: 'Template sections' });
    expect(
      within(tabs)
        .getAllByRole('tab')
        .map((t) => t.textContent),
    ).toEqual(['Sites', 'Sessions', 'Versions', 'Access', 'Settings', 'Activity']);
    expect(screen.getByRole('heading', { level: 2, name: 'linkedin.com' })).toBeDefined();
    expect(screen.getByRole('heading', { level: 2, name: 'indeed.com' })).toBeDefined();
    expect(screen.getAllByText('Signed in').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /Restart/ })).toBeDefined();
    await expectNoA11yViolations(view.container, { disable: ['aria-hidden-focus'] });
  });

  it('writes the tab to the URL and marks BrowserHive’s own sessions', async () => {
    const view = mount(`/templates/${ID}`);
    const tab = await screen.findByRole('tab', { name: 'Sessions' });
    await act(async () => {
      fireEvent.click(tab);
    });
    await waitFor(() =>
      expect(view.router.state.location.search).toMatchObject({ tab: 'sessions' }),
    );
    const list = await screen.findByRole('list', { name: 'Sessions of this template' });
    expect(within(list).getByText('BrowserHive (system)')).toBeDefined();
    expect(screen.getByRole('region', { name: 'Other windows' })).toBeDefined();
    const sessions = view.requests.find((r) => r.path.endsWith('/sessions'));
    expect(sessions?.query.get('template')).toBe(ID);
    expect(sessions?.query.get('maintenance')).toBe('include');
    await expectNoA11yViolations(view.container, { disable: ['aria-hidden-focus'] });
  });

  it('lists versions with the checkpoint first; axe clean', async () => {
    const view = mount(`/templates/${ID}?tab=versions`);
    const list = await screen.findByRole('list', { name: 'Versions' });
    expect(within(list).getByText('Rolling checkpoint')).toBeDefined();
    expect(within(list).getByText('Version 2')).toBeDefined();
    expect(within(list).getByText('Last good')).toBeDefined();
    expect(within(list).getAllByRole('button', { name: /Restore/ }).length).toBe(3);
    await expectNoA11yViolations(view.container, { disable: ['aria-hidden-focus'] });
  });

  it('says versions are not available on a server without them', async () => {
    mount(`/templates/${ID}?tab=versions`, {
      [`GET /templates/${ID}/versions`]: problem(404, 'NOT_FOUND'),
    });
    expect(await screen.findByText('Versions aren’t available on this server yet')).toBeDefined();
  });

  it('renders Access and Settings; axe clean', async () => {
    const access = mount(`/templates/${ID}?tab=access`);
    await screen.findByRole('heading', { name: 'Who may use it' });
    expect(screen.getByText(/Every agent of this hive/)).toBeDefined();
    expect(screen.getByRole('switch', { name: 'Allow evaluate' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Save access' }).hasAttribute('disabled')).toBe(true);
    await expectNoA11yViolations(access.container, { disable: ['aria-hidden-focus'] });
    access.unmount();
    const settings = mount(`/templates/${ID}?tab=settings`);
    await screen.findByText('Recorded at the first start.');
    expect(screen.getByText('America/Toronto')).toBeDefined();
    await expectNoA11yViolations(settings.container, { disable: ['aria-hidden-focus'] });
  });

  it('deletes after the typed name', async () => {
    const view = mount(`/templates/${ID}`, {
      [`DELETE /templates/${ID}`]: { ok: true, closed_sessions: [], deleted_bytes: 1024 },
      'GET /sessions': sessionsPage([]),
    });
    await screen.findByRole('heading', { level: 1, name: 'Job hunt' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'More actions for Job hunt' }));
    });
    const item = await screen.findByRole('menuitem', { name: /Delete/ });
    await act(async () => {
      fireEvent.click(item);
    });
    const confirm = await screen.findByRole('button', { name: 'Delete template' });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    const input = screen.getByLabelText(/to confirm/);
    await act(async () => {
      fireEvent.change(input, { target: { value: 'job-hunt' } });
    });
    await act(async () => {
      fireEvent.click(confirm);
    });
    await waitFor(() =>
      expect(
        view.requests.some((r) => r.method === 'DELETE' && r.path.endsWith(`/templates/${ID}`)),
      ).toBe(true),
    );
    const call = view.requests.find((r) => r.method === 'DELETE');
    expect(call?.query.get('force')).toBe('false');
  });

  it('removes an unlisted sign-in', async () => {
    const view = mount(`/templates/${ID}`, {
      [`GET /templates/${ID}`]: templateDetail({}, { unlisted_domains: ['google.com'] }),
      [`POST /templates/${ID}/domains/google.com/remove-sign-in`]: {
        ok: true,
        cookies_removed: 3,
        origins_cleared: [],
        uncleared_origins: [],
      },
    });
    const button = await screen.findByRole('button', { name: 'Remove sign-in to google.com' });
    await act(async () => {
      fireEvent.click(button);
    });
    await waitFor(() =>
      expect(
        view.requests.some((r) => r.method === 'POST' && r.path.endsWith('/remove-sign-in')),
      ).toBe(true),
    );
  });

  it('shows a not-found page with a way back', async () => {
    mount(`/templates/${ID}`, { [`GET /templates/${ID}`]: problem(404, 'TEMPLATE_NOT_FOUND') });
    expect(await screen.findByText('Template not found')).toBeDefined();
    expect(screen.getByRole('link', { name: /Back to templates/ })).toBeDefined();
  });
});

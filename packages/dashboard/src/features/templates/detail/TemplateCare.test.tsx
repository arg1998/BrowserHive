/** @module features/templates/detail/TemplateCare.test — the template page's care paths: a ready template with a signed-out site says so and offers Sign in again (banner and card), a template still being set up shows one Continue sign-in notice, and Stop lists the live sessions it closes before stopping (none, no question) */
import { describe, expect, it } from 'bun:test';
import { sessionSummary, sessionsPage } from '../../../../test/fixtures/sessions.ts';
import {
  signedInSite,
  templateDetail,
  templateSite,
  tid,
} from '../../../../test/fixtures/templates.ts';
import { expectNoA11yViolations } from '../../../../test/helpers/axe.ts';
import { renderPage } from '../../../../test/helpers/page-harness.tsx';
import { act, fireEvent, screen, waitFor, within } from '../../../../test/helpers/render.tsx';
import { templatePageSearch } from '../search.ts';
import { TemplatePage } from './TemplatePage.tsx';

const ID = tid(1);
const signedOut = templateSite('indeed.com', {
  health: {
    state: 'signed_out',
    checked_at: 1,
    changed_at: 1,
    reason: 'not_confirmed',
    consecutive_inconclusive: 0,
  },
});

function mount(routes: Record<string, unknown>) {
  return renderPage({
    path: '/templates/$id',
    component: TemplatePage,
    validateSearch: (s) => templatePageSearch.parse(s),
    routes: { 'GET /system': { vault: { enabled: false, backend: null } }, ...routes },
    url: `/templates/${ID}`,
  });
}

describe('template care', () => {
  it('says a ready template has a signed-out site and links to signing in again; axe clean', async () => {
    const view = mount({
      [`GET /templates/${ID}`]: templateDetail({
        sites: [signedInSite('linkedin.com'), signedOut],
      }),
    });
    expect(await screen.findByText('1 site isn’t signed in')).toBeDefined();
    expect(screen.getByText(/Agents get signed-out pages on indeed.com/)).toBeDefined();
    const links = screen.getAllByRole('link', { name: /Sign in again/ });
    expect(links.length).toBe(2);
    for (const link of links)
      expect(link.getAttribute('href')).toBe(`/templates/new?step=5&template=${ID}&again=1`);
    await expectNoA11yViolations(view.container, { disable: ['aria-hidden-focus'] });
  });

  it('shows one Continue sign-in notice while the template is being set up', async () => {
    mount({
      [`GET /templates/${ID}`]: templateDetail({
        status: 'recording',
        sites: [templateSite('linkedin.com'), templateSite('indeed.com')],
      }),
    });
    expect(await screen.findByText('Not signed in yet')).toBeDefined();
    expect(screen.queryAllByRole('link', { name: /Sign in again/ })).toHaveLength(0);
    expect(screen.getAllByRole('link', { name: /Continue sign-in/ }).length).toBeGreaterThan(0);
  });

  it('lists the live sessions before stopping the browser', async () => {
    const view = mount({
      [`GET /templates/${ID}`]: templateDetail(),
      'GET /sessions': sessionsPage([sessionSummary(1, { slug: 'research' })]),
      [`POST /templates/${ID}/host/stop`]: { host: templateDetail().host },
    });
    await screen.findByRole('heading', { level: 1, name: 'Job hunt' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Stop/ }));
    });
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/research/)).toBeDefined();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Stop browser' }));
    });
    await waitFor(() =>
      expect(view.requests.some((r) => r.path.endsWith('/host/stop'))).toBe(true),
    );
  });

  it('stops at once when no session uses the browser', async () => {
    const view = mount({
      [`GET /templates/${ID}`]: templateDetail(),
      'GET /sessions': sessionsPage([]),
      [`POST /templates/${ID}/host/stop`]: { host: templateDetail().host },
    });
    await screen.findByRole('heading', { level: 1, name: 'Job hunt' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Stop/ }));
    });
    await waitFor(() =>
      expect(view.requests.some((r) => r.path.endsWith('/host/stop'))).toBe(true),
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

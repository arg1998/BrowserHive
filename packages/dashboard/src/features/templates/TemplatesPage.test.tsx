/** @module features/templates/TemplatesPage.test — `/templates`: rows with each site's health, Browser and sessions, whole-row links, Setting up with Continue sign-in, facet chips written to the URL and the REST query, the first-visit explainer, zero results; axe on each */
import { describe, expect, it } from 'bun:test';
import { templateSummary, templatesPage } from '../../../test/fixtures/templates.ts';
import { expectNoA11yViolations } from '../../../test/helpers/axe.ts';
import { renderPage } from '../../../test/helpers/page-harness.tsx';
import { act, fireEvent, screen, waitFor, within } from '../../../test/helpers/render.tsx';
import { templatesSearch } from './search.ts';
import { TemplatesPage, templatesCountText } from './TemplatesPage.tsx';

const ROWS = [
  templateSummary(1, {
    sites: [
      { site_id: 'linkedin.com', title: 'linkedin.com', health_state: 'signed_in', checked_at: 1 },
      { site_id: 'indeed.com', title: 'indeed.com', health_state: 'signed_out', checked_at: 1 },
    ],
  }),
  templateSummary(2, {
    name: 'mail-ops',
    display_name: 'Mail operations',
    status: 'recording',
    host: { state: 'stopped', since: null, pages: 0 },
    in_use: 0,
    last_used_at: null,
  }),
];

function mount(url: string, rows = ROWS) {
  return renderPage({
    path: '/templates',
    component: TemplatesPage,
    validateSearch: (s) => templatesSearch.parse(s),
    routes: {
      'GET /templates': (req: { query: URLSearchParams }) =>
        req.query.get('q') === 'zzz'
          ? { ...templatesPage([]), facets: templatesPage(rows).facets }
          : templatesPage(rows),
      'GET /sessions': {
        data: [],
        page: { next_cursor: null, limit: 100 },
        applied: { filters: {}, sort: { key: 'created_at', dir: 'desc' } },
        meta: { now: 0 },
        facets: {
          owners: [],
          channels: [],
          persistence_modes: [],
          states: [],
          harnesses: [],
          templates: [],
        },
      },
    },
    url,
  });
}

const lastList = (requests: readonly { method: string; path: string; query: URLSearchParams }[]) =>
  requests.filter((r) => r.method === 'GET' && r.path === '/api/v1/templates').at(-1);

describe('TemplatesPage', () => {
  it('lists templates with their sites, browser and sessions as whole-row links; axe clean', async () => {
    const view = mount('/templates');
    const table = await screen.findByRole('region', { name: 'Templates' });
    // The table and its phone cards both render here (CSS picks one by width).
    expect(within(table).getAllByText('Job hunt').length).toBeGreaterThan(0);
    expect(within(table).getAllByText('job-hunt').length).toBeGreaterThan(0);
    expect(within(table).getAllByText(/indeed\.com/).length).toBeGreaterThan(0);
    expect(within(table).getAllByText(': Signed out').length).toBeGreaterThan(0);
    expect(within(table).getAllByText('Running').length).toBeGreaterThan(0);
    expect(within(table).getAllByText('2 / 5').length).toBeGreaterThan(0);
    const links = within(table).getAllByRole('link', { name: 'Job hunt' });
    expect(links.every((l) => l.getAttribute('href') === '/templates/tp-0000000001')).toBe(true);
    expect(screen.getByText('2 templates · 1 site needs a sign-in')).toBeDefined();
    const query = lastList(view.requests)?.query;
    expect(query?.get('sort')).toBe('name');
    expect(query?.get('dir')).toBe('asc');
    await expectNoA11yViolations(view.container);
  }, 15_000);

  it('marks a template being set up and offers Continue sign-in', async () => {
    const view = mount('/templates');
    await screen.findByRole('region', { name: 'Templates' });
    expect(screen.getAllByText('Mail operations').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Setting up').length).toBeGreaterThan(0);
    const buttons = screen.getAllByRole('button', { name: /Continue sign-in/ });
    await act(async () => {
      fireEvent.click(buttons[0] as HTMLElement);
    });
    await waitFor(() => expect(view.router.state.location.pathname).toBe('/templates/new'));
    expect(view.router.state.location.search).toMatchObject({
      step: 5,
      template: 'tp-0000000002',
    });
  });

  it('writes a status chip to the URL and the REST query', async () => {
    const view = mount('/templates');
    const chip = await screen.findByRole('button', { name: /Setting up/ });
    await act(async () => {
      fireEvent.click(chip);
    });
    await waitFor(() =>
      expect(view.router.state.location.search).toMatchObject({ status: ['recording'] }),
    );
    await waitFor(() => expect(lastList(view.requests)?.query.get('status')).toBe('recording'));
  });

  it('explains templates on the first visit; axe clean', async () => {
    const view = mount('/templates', []);
    await screen.findByRole('heading', { name: 'Sign in once, let every agent use it' });
    expect(screen.getByRole('list', { name: 'How it works' })).toBeDefined();
    expect(screen.getAllByRole('link', { name: /New template/ })).toHaveLength(1);
    expect(screen.queryByRole('searchbox')).toBeNull();
    await expectNoA11yViolations(view.container);
  });

  it('shows zero results with Clear filters when a search matches nothing', async () => {
    const view = mount('/templates?q=zzz');
    await screen.findByText('No templates match these filters');
    await expectNoA11yViolations(view.container);
  });

  it('counts the sites that need a sign-in in the header line', () => {
    expect(templatesCountText(ROWS, 2)).toBe('2 templates · 1 site needs a sign-in');
    expect(templatesCountText(ROWS.slice(1), 1)).toBe('1 template');
  });
});

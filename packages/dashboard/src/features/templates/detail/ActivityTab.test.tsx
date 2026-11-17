/** @module features/templates/detail/ActivityTab.test — the Activity tab (spec 13 §8, §11.4): sign-in checks newest first with outcome, reason, why and duration; site, outcome and trigger filters in the URL and the request; older pages; a new check over `template.probe`; empty and zero-result states; axe clean */
import { describe, expect, it } from 'bun:test';
import { probeRow, probesPage, templateDetail, tid } from '../../../../test/fixtures/templates.ts';
import { expectNoA11yViolations } from '../../../../test/helpers/axe.ts';
import { type RecordedRequest, renderPage } from '../../../../test/helpers/page-harness.tsx';
import { act, fireEvent, screen, waitFor, within } from '../../../../test/helpers/render.tsx';
import { templatePageSearch } from '../search.ts';
import { TemplatePage } from './TemplatePage.tsx';

const ID = tid(1);
const AXE = { disable: ['aria-hidden-focus'] } as const;

function mount(probes: unknown, url = `/templates/${ID}?tab=activity`) {
  return renderPage({
    path: '/templates/$id',
    component: TemplatePage,
    validateSearch: (s) => templatePageSearch.parse(s),
    routes: {
      [`GET /templates/${ID}`]: templateDetail(),
      [`GET /templates/${ID}/probes`]: probes,
      'GET /system': { vault: { enabled: false, backend: null } },
    },
    url,
  });
}

const probeCalls = (requests: readonly RecordedRequest[]) =>
  requests.filter((r) => r.path.endsWith('/probes'));

describe('Activity tab', () => {
  it('lists checks newest first with what they found and why they ran; axe clean', async () => {
    const view = mount(
      probesPage([
        probeRow(1, {
          site_id: 'indeed.com',
          outcome: 'signed_out',
          reason: 'cookies_absent',
          trigger: 'prelaunch',
          duration_ms: 1500,
          final_url: 'https://secure.indeed.com/auth',
        }),
        probeRow(2),
      ]),
    );
    const list = await screen.findByRole('region', { name: 'Sign-in checks' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]?.getAttribute('data-outcome')).toBe('signed_out');
    expect(
      within(items[0] as HTMLElement).getByText('Its sign-in cookies are gone.'),
    ).toBeDefined();
    expect(within(items[0] as HTMLElement).getByText('Before a launch')).toBeDefined();
    expect(within(items[0] as HTMLElement).getByText('1.5 s')).toBeDefined();
    expect(within(items[0] as HTMLElement).getByText('secure.indeed.com')).toBeDefined();
    expect(within(items[1] as HTMLElement).getByText('Scheduled')).toBeDefined();
    await expectNoA11yViolations(view.container, AXE);
  });

  it('reads its filters from the URL and writes chip changes back', async () => {
    const view = mount(
      probesPage([probeRow(1)]),
      `/templates/${ID}?tab=activity&site=linkedin.com&outcome=signed_in`,
    );
    await screen.findByRole('region', { name: 'Sign-in checks' });
    const first = probeCalls(view.requests)[0];
    expect(first?.query.get('site_id')).toBe('linkedin.com');
    expect(first?.query.get('outcome')).toBe('signed_in');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Check now/ }));
    });
    await waitFor(() =>
      expect(view.router.state.location.search).toMatchObject({ trigger: ['manual'] }),
    );
    await waitFor(() =>
      expect(probeCalls(view.requests).at(-1)?.query.get('trigger')).toBe('manual'),
    );
  });

  it('loads older checks with the cursor', async () => {
    const view = mount((request: RecordedRequest) =>
      request.query.get('cursor') === 'c2'
        ? probesPage([probeRow(3, { reason: 'partial_cookies', outcome: 'inconclusive' })])
        : probesPage([probeRow(1), probeRow(2)], 'c2'),
    );
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Show older checks' }));
    });
    expect(await screen.findByText('Only some of its sign-in cookies are there.')).toBeDefined();
    expect(probeCalls(view.requests).at(-1)?.query.get('cursor')).toBe('c2');
  });

  it('refreshes when a check finishes (template.probe)', async () => {
    const view = mount(probesPage([probeRow(1)]));
    await screen.findByRole('region', { name: 'Sign-in checks' });
    const before = probeCalls(view.requests).length;
    view.connect();
    view.emit('templates', { type: 'template.probe', template_id: ID, probe: probeRow(9) });
    await waitFor(() => expect(probeCalls(view.requests).length).toBeGreaterThan(before));
  });

  it('explains an empty history and filters that match nothing', async () => {
    mount(probesPage([]));
    expect(await screen.findByText('No sign-in checks yet')).toBeDefined();
  });

  it('offers to clear filters that match nothing', async () => {
    const view = mount(probesPage([]), `/templates/${ID}?tab=activity&outcome=challenged`);
    expect(await screen.findByText('No checks match these filters')).toBeDefined();
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /Clear/ })[0] as HTMLElement);
    });
    await waitFor(() => expect(view.router.state.location.search).not.toHaveProperty('outcome'));
  });
});

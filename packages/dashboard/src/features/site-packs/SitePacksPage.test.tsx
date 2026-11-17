/** @module features/site-packs/SitePacksPage.test — `/site-packs` (spec 13 §11.4, T3a) over fake routes: the packs table with provenance, approved version and SHA-256, local state; Updates available with a pending bundled version (diff as text, Apply behind a confirmation, Reject, Pin) and a local file (Approve naming the SHA-256); filters and the tab in the URL; Import… listing SITE_PACK_INVALID issues; Reload; live updates over `site-packs`; the History tab; empty and `sitePacks=false` states; axe on each */
import { describe, expect, it } from 'bun:test';
import {
  offeredPack,
  packDiff,
  packsResponse,
  packView,
  registryStatus,
  sha,
} from '../../../test/fixtures/site-packs.ts';
import { expectNoA11yViolations } from '../../../test/helpers/axe.ts';
import { envelope, type FakeRoute, renderPage } from '../../../test/helpers/page-harness.tsx';
import { act, fireEvent, screen, waitFor, within } from '../../../test/helpers/render.tsx';
import { iso } from './model.ts';
import { SitePacksPage } from './SitePacksPage.tsx';
import { sitePacksSearch } from './search.ts';

const AXE = { disable: ['aria-hidden-focus'] } as const;

/** LinkedIn with bundled v4 pending, GitHub offered with a local file not yet approved. */
function packsWithDecisions() {
  return [
    packView({
      pending: [
        {
          version: 4,
          sha256: sha('c'),
          state: 'downloaded',
          size: 4096,
          released: '2026-12-01',
          notes: null,
          classification: 'tightening',
          source: 'bundled',
          provenance: { kind: 'bundled', release: '0.3.1' },
        },
      ],
    }),
    offeredPack({
      local: {
        path: '/data/site-packs/local/github.com.json',
        sha256: sha('d'),
        state: 'not_approved',
        approved_sha256: null,
        problem: null,
      },
    }),
  ];
}

function mount(routes: Record<string, FakeRoute>, url = '/site-packs') {
  return renderPage({
    path: '/site-packs',
    component: SitePacksPage,
    validateSearch: (s) => sitePacksSearch.parse(s),
    routes: {
      'GET /site-packs': packsResponse(packsWithDecisions(), {
        pending_count: 1,
        local_needing_approval: 1,
      }),
      'GET /site-packs/linkedin.com/diff': packDiff(),
      'GET /site-packs/github.com/diff': packDiff({
        from: null,
        to: { version: 1, sha256: sha('d'), source: 'local' },
        changes: [],
      }),
      ...routes,
    },
    url,
  });
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
  });
}

describe('SitePacksPage', () => {
  it('lists packs and the decisions waiting; axe clean', async () => {
    const view = mount({});
    const updates = await screen.findByRole('heading', { level: 2, name: /Updates available/ });
    expect(updates.textContent).toContain('2');
    const linkedin = (await screen.findByRole('heading', { level: 3, name: /LinkedIn/ })).closest(
      'article',
    ) as HTMLElement;
    expect(within(linkedin).getByText('v3 → v4')).toBeDefined();
    expect(within(linkedin).getByText('Bundled with BrowserHive 0.3.1')).toBeDefined();
    // The diff, as text: the field, its old and new value.
    expect(await within(linkedin).findByText('guards[logout].action')).toBeDefined();
    expect(within(linkedin).getByText('confirm')).toBeDefined();
    expect(within(linkedin).getByText('block')).toBeDefined();
    // Classified: the card's chip, the diff's chip and the field's chip, in words (never colour alone).
    expect(within(linkedin).getAllByText('Tightens rules').length).toBe(3);
    const github = screen
      .getByRole('heading', { level: 3, name: /GitHub/ })
      .closest('article') as HTMLElement;
    expect(within(github).getByText('Not yet approved')).toBeDefined();
    expect(within(github).getByText('/data/site-packs/local/github.com.json')).toBeDefined();
    // The table: provenance, approved version and short SHA-256, the offer of an unapproved pack.
    const table = await screen.findByRole('region', { name: 'Site packs' });
    expect(within(table).getAllByText('Bundled with BrowserHive 0.3.0').length).toBeGreaterThan(0);
    expect(within(table).getByText('v3')).toBeDefined();
    expect(within(table).getByText(`${sha('a').slice(0, 12)}…`, { exact: false })).toBeDefined();
    expect(within(table).getAllByText('v2 on first use').length).toBeGreaterThan(0);
    expect(screen.getByText('/data/site-packs/local')).toBeDefined();
    await expectNoA11yViolations(view.container, AXE);
  });

  it('Apply asks first, then applies the version; Reject and Pin send theirs', async () => {
    const view = mount({
      'POST /site-packs/linkedin.com/apply': { view: packView({ pending: [] }) },
      'POST /site-packs/linkedin.com/reject': { view: packView({ pending: [] }) },
      'PUT /site-packs/linkedin.com/pin': { view: packView({ pinned_version: 3 }) },
    });
    const card = (await screen.findByRole('heading', { level: 3, name: /LinkedIn/ })).closest(
      'article',
    ) as HTMLElement;
    await click(within(card).getByRole('button', { name: 'Apply…' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(`Apply ${iso('LinkedIn')} v4?`)).toBeDefined();
    expect(within(dialog).getByText(/v3 is kept, so Revert restores it/)).toBeDefined();
    expect(within(dialog).getByText(/This version only tightens rules/)).toBeDefined();
    await expectNoA11yViolations(document.body, AXE);
    await click(within(dialog).getByRole('button', { name: 'Apply v4' }));
    await waitFor(() =>
      expect(view.requests.find((r) => r.path.endsWith('/apply'))?.body).toEqual({ version: 4 }),
    );
    await click(within(card).getByRole('button', { name: 'Reject' }));
    await waitFor(() =>
      expect(view.requests.find((r) => r.path.endsWith('/reject'))?.body).toEqual({ version: 4 }),
    );
    await click(within(card).getByRole('button', { name: 'Pin v3' }));
    await waitFor(() =>
      expect(view.requests.find((r) => r.path.endsWith('/pin'))?.body).toEqual({ version: 3 }),
    );
  });

  it('Approve names the SHA-256 of the reviewed local file and sends it', async () => {
    const view = mount({
      'POST /site-packs/github.com/approve-local': { view: offeredPack() },
    });
    const card = (await screen.findByRole('heading', { level: 3, name: /GitHub/ })).closest(
      'article',
    ) as HTMLElement;
    expect(await within(card).findByText('The content is the same.')).toBeDefined();
    await click(within(card).getByRole('button', { name: 'Approve…' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(`SHA-256 ${sha('d')}`)).toBeDefined();
    expect(within(dialog).getByText(iso('/data/site-packs/local/github.com.json'))).toBeDefined();
    await click(within(dialog).getByRole('button', { name: 'Approve this content' }));
    await waitFor(() =>
      expect(view.requests.find((r) => r.path.endsWith('/approve-local'))?.body).toEqual({
        sha256: sha('d'),
      }),
    );
  });

  it('keeps the filters and the tab in the URL and sends them as the query', async () => {
    const view = mount({}, '/site-packs?source=local&pending=1&q=link');
    await screen.findByRole('region', { name: 'Site packs' });
    const filtered = view.requests.find(
      (r) => r.path === '/api/v1/site-packs' && r.query.get('q') === 'link',
    );
    expect(filtered?.query.get('source')).toBe('local');
    expect(filtered?.query.get('pending')).toBe('true');
    await click(screen.getByRole('button', { name: /^Bundled/ }));
    await waitFor(() =>
      expect(view.router.state.location.search).toMatchObject({ source: ['local', 'bundled'] }),
    );
    await click(screen.getByRole('tab', { name: 'History' }));
    await waitFor(() =>
      expect(view.router.state.location.search).toMatchObject({ tab: 'history' }),
    );
  });

  it('Import… lists every invalid field of a refused file', async () => {
    mount({
      'POST /site-packs/import': {
        status: 400,
        body: {
          type: 'about:blank',
          title: 'Site pack invalid',
          status: 400,
          code: 'SITE_PACK_INVALID',
          retryable: 'different_args',
          details: {
            source: 'import',
            issues: [
              { path: 'guards[0].match.url', message: 'the host is not one of the domains' },
            ],
            issues_text: 'guards[0].match.url: the host is not one of the domains',
          },
        },
      },
    });
    const input = (await screen.findByLabelText('Site pack file')) as HTMLInputElement;
    const file = new File([JSON.stringify({ schema: 1 })], 'bad.json', {
      type: 'application/json',
    });
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });
    expect(await screen.findByText('bad.json isn’t a valid site pack')).toBeDefined();
    expect(screen.getByText('guards[0].match.url')).toBeDefined();
    expect(screen.getByText(/the host is not one of the domains/)).toBeDefined();
  });

  it('Reload local packs reports what it loaded', async () => {
    const view = mount({
      'POST /site-packs/reload': {
        stats: {
          loaded_at: 1,
          sources: [
            { source: 'bundled', loaded: 2, skipped: [] },
            {
              source: 'local',
              loaded: 1,
              skipped: [{ pack_id: 'x.com', version: 1, reason: 'invalid', detail: 'bad' }],
            },
          ],
        },
      },
    });
    await click(await screen.findByRole('button', { name: 'Reload local packs' }));
    await waitFor(() => expect(view.requests.some((r) => r.path.endsWith('/reload'))).toBe(true));
    expect((await screen.findAllByText('Loaded 3 pack versions')).length).toBeGreaterThan(0);
  });

  it('updates live from site_pack.changed', async () => {
    let enabled = true;
    const view = mount({ 'GET /site-packs': () => packsResponse([packView({ enabled })]) });
    await screen.findByRole('region', { name: 'Site packs' });
    expect(screen.queryAllByText('Turned off')).toEqual([]);
    view.connect();
    enabled = false;
    view.emit('site-packs', { type: 'site_pack.changed', view: packView({ enabled: false }) });
    expect((await screen.findAllByText('Turned off')).length).toBeGreaterThan(0);
  });

  it('shows the history tab', async () => {
    mount(
      {
        'GET /site-packs/changes': envelope([
          {
            seq: 1,
            event_id: 'e-1',
            pack_id: 'linkedin.com',
            from_version: 2,
            to_version: 3,
            to_sha256: sha('a'),
            source: 'bundled',
            classification: 'unclassified',
            new_domains: [],
            notes: null,
            decision: 'approved',
            decided_by: 'admin',
            created_at: 1_700_000_000_000,
            decided_at: 1_700_000_000_000,
          },
        ]),
      },
      '/site-packs?tab=history',
    );
    const list = await screen.findByRole('region', { name: 'Pack history' });
    expect(within(list).getByText('v2 → v3')).toBeDefined();
    expect(within(list).getByText('Approved')).toBeDefined();
    expect(within(list).getByText('by admin')).toBeDefined();
  });

  it('explains an empty catalog and sitePacks=false; axe clean', async () => {
    const empty = mount({ 'GET /site-packs': packsResponse([]) });
    expect(await screen.findByText('No site packs yet')).toBeDefined();
    expect(screen.queryByRole('heading', { name: /Updates available/ })).toBeNull();
    await expectNoA11yViolations(empty.container, AXE);
    empty.unmount();
    const off = mount({
      'GET /site-packs': packsResponse([], { status: registryStatus({ enabled: false }) }),
    });
    expect(await screen.findByText('Site packs are turned off')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Reload local packs' })).toBeNull();
    await expectNoA11yViolations(off.container, AXE);
  });
});

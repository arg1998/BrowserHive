/** @module features/site-packs/registry.test — the registry client on `/site-packs` and `/site-packs/$id` (spec 13 §10.4–§10.6, §11.4, T4b) over fake routes, axe on each state: loading, empty, error, an out-of-date index (clock hint), a failing check, the update check off, no trusted registry, a pending version that relaxes rules and one that tightens them, a listed version not downloaded (Download & review sends the version, shows the diff, focus returns to the card), a revoked version with its fallback and one kept without, pinned, auto-update, `sitePacks=false`; Check now (outcome toast, a 429 waits with its reason), Download all, Apply selected (one confirmation listing what relaxes rules, then each version in turn), a signed folder's import (its body and result), the Online and Imported chips in the URL, a live status event */
import { describe, expect, it } from 'bun:test';
import type { SitePackView } from '@browserhive/contracts/http';
import {
  onlineStatus,
  packContent,
  packDetail,
  packDiff,
  packsResponse,
  packView,
  pendingVersion,
  registryStatus,
  sha,
} from '../../../test/fixtures/site-packs.ts';
import { expectNoA11yViolations } from '../../../test/helpers/axe.ts';
import {
  envelope,
  type FakeRoute,
  problem,
  renderPage,
} from '../../../test/helpers/page-harness.tsx';
import { act, fireEvent, screen, waitFor, within } from '../../../test/helpers/render.tsx';
import { SitePackPage } from './detail/SitePackPage.tsx';
import { SitePacksPage } from './SitePacksPage.tsx';
import { sitePacksSearch } from './search.ts';

const AXE = { disable: ['aria-hidden-focus'] } as const;

function mount(routes: Record<string, FakeRoute>, url = '/site-packs') {
  return renderPage({
    path: '/site-packs',
    component: SitePacksPage,
    validateSearch: (s) => sitePacksSearch.parse(s),
    routes: { 'GET /templates': envelope([]), 'GET /site-packs/changes': envelope([]), ...routes },
    url,
  });
}

function list(packs: readonly SitePackView[], status = onlineStatus(), pendingCount = 0) {
  return { 'GET /site-packs': packsResponse(packs, { status, pending_count: pendingCount }) };
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
  });
}

async function card(name: RegExp) {
  return (await screen.findByRole('heading', { level: 3, name })).closest('article') as HTMLElement;
}

/** The registry's online LinkedIn: v3 approved from the index. */
function linkedin(patch: Partial<SitePackView> = {}) {
  return packView({
    sources: ['bundled', 'remote'],
    online: {
      version: 4,
      sha256: sha('c'),
      size: 6656,
      released: '2026-11-19',
      notes: 'x',
      revoked: false,
      needs_client: null,
      usable_version: 4,
    },
    ...patch,
  });
}

describe('registry states', () => {
  it('loading: skeletons while the list loads', async () => {
    const view = mount({ 'GET /site-packs': () => new Promise(() => undefined) });
    expect(await screen.findByRole('heading', { level: 1, name: 'Site packs' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull();
    await expectNoA11yViolations(view.container, AXE);
  });

  it('empty: says where packs come from', async () => {
    const view = mount(list([]));
    expect(await screen.findByText('No site packs yet')).toBeDefined();
    expect(screen.getByText(/the registry lists none yet/)).toBeDefined();
    await expectNoA11yViolations(view.container, AXE);
  });

  it('error: the list failing shows a retry', async () => {
    const view = mount({ 'GET /site-packs': problem(500, 'INTERNAL_ERROR', 'Internal error') });
    expect(await screen.findByRole('button', { name: /Try again|Retry/ })).toBeDefined();
    await expectNoA11yViolations(view.container, AXE);
  });

  it('up to date: the check line, the registry card and what a check sends', async () => {
    const view = mount(list([linkedin()]));
    const meta = await screen.findByText('up to date');
    expect(meta.closest('[data-check-outcome]')?.textContent).toMatch(/Checked .*up to date/);
    expect(meta.closest('[data-check-outcome]')?.textContent).toContain('Next check in');
    const registry = screen.getByRole('region', { name: /Registry and sources/ });
    expect(within(registry).getByText('https://browserhive.ai/registry/v1/')).toBeDefined();
    expect(within(registry).getByText(/Version 1412 · 18 packs/)).toBeDefined();
    expect(within(registry).getByText('k-2026a')).toBeDefined();
    expect(within(registry).getByText('sitePacksUpdateCheck')).toBeDefined();
    expect(within(registry).getByText('sitePacksAutoUpdate')).toBeDefined();
    expect(
      within(registry).getByText(/No cookie, query, version or install identifier/),
    ).toBeDefined();
    expect(within(registry).getByText(/Index 1405 · verified/)).toBeDefined();
    // The table: where it came from and the other sources.
    const table = screen.getByRole('region', { name: 'Site packs' });
    expect(within(table).getAllByText('Also online').length).toBeGreaterThan(0);
    expect(within(table).getAllByText('v4 online').length).toBeGreaterThan(0);
    await expectNoA11yViolations(view.container, AXE);
  });

  it('stale: the index is out of date, with the clock hint; downloads wait', async () => {
    const view = mount(
      list(
        [
          linkedin({
            pending: [pendingVersion({ state: 'available', classification: 'unclassified' })],
          }),
        ],
        onlineStatus({ stale: true, clock_skew_ms: 3 * 3_600_000 }),
        1,
      ),
    );
    expect(await screen.findByText('The registry index is out of date')).toBeDefined();
    expect(screen.getByText(/check the system clock/)).toBeDefined();
    expect(screen.getByText('index out of date')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Download all' }).hasAttribute('disabled')).toBe(
      true,
    );
    const linkedinCard = await card(/LinkedIn/);
    expect(
      within(linkedinCard)
        .getByRole('button', { name: /Download & review/ })
        .hasAttribute('disabled'),
    ).toBe(true);
    await expectNoA11yViolations(view.container, AXE);
  });

  it('failed: three failed checks name the error', async () => {
    const view = mount(
      list(
        [linkedin()],
        onlineStatus({
          last_outcome: 'failed',
          failures: 3,
          last_error: {
            code: 'fetch_failed',
            message: 'browserhive.ai did not answer within 5 s.',
          },
        }),
      ),
    );
    expect(await screen.findByText('The last 3 update checks failed')).toBeDefined();
    expect(screen.getAllByText('browserhive.ai did not answer within 5 s.').length).toBe(2);
    expect(screen.getByText('failed')).toBeDefined();
    expect(screen.getByText('3 in a row')).toBeDefined();
    await expectNoA11yViolations(view.container, AXE);
  });

  it('update check off: no request, Check now disabled with its reason', async () => {
    const view = mount(list([packView()], registryStatus()));
    expect(await screen.findByText('Update check off', { selector: 'span' })).toBeDefined();
    expect(
      screen.getByText(/BrowserHive makes no request to the registry. Import packs by hand/),
    ).toBeDefined();
    expect(screen.getByRole('button', { name: 'Check now' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('Off: no request is made')).toBeDefined();
    await expectNoA11yViolations(view.container, AXE);
  });

  it('no trusted registry: says the check stays off until keys are pinned', async () => {
    const view = mount(
      list(
        [packView()],
        registryStatus({
          check_off: 'no_trust_root',
          update_check: true,
          snapshot: { index_version: 1405, verified: false, detail: 'no keys pinned' },
        }),
      ),
    );
    expect(await screen.findByText('No registry trusted yet', { selector: 'p' })).toBeDefined();
    expect(screen.getByText(/stays off until registry keys are pinned in a release/)).toBeDefined();
    expect(screen.getByText(/not verified, not used/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Check now' }).hasAttribute('disabled')).toBe(true);
    await expectNoA11yViolations(view.container, AXE);
  });

  it('sitePacks=false: no registry controls', async () => {
    const view = mount(list([], registryStatus({ enabled: false, check_off: 'packs_off' })));
    expect(await screen.findByText('Site packs are turned off')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Download all' })).toBeNull();
    await expectNoA11yViolations(view.container, AXE);
  });
});

describe('pending versions', () => {
  it('a version that relaxes rules: chip, new domains, highlighted fields; Apply asks with care', async () => {
    const pending = pendingVersion({
      classification: 'loosening',
      new_domains: ['lnkd.in'],
      notes: 'Covers lnkd.in short links.',
    });
    const view = mount({
      ...list([linkedin({ pending: [pending] })], onlineStatus(), 1),
      'GET /site-packs/linkedin.com/diff': packDiff({
        classification: 'loosening',
        new_domains: ['lnkd.in'],
        changes: [{ path: 'guards[logout]', from: { id: 'logout' }, to: null, class: 'loosening' }],
      }),
    });
    const c = await card(/LinkedIn/);
    expect(within(c).getAllByText('Relaxes rules').length).toBeGreaterThan(0);
    expect(within(c).getByText('Covers lnkd.in short links.')).toBeDefined();
    expect(within(c).getByText('Publisher’s notes')).toBeDefined();
    expect(
      within(c).getByText(
        'browserhive.ai registry · key k-2026a · signature verified · index 1413',
      ),
    ).toBeDefined();
    expect(await within(c).findByText('New domains:')).toBeDefined();
    await expectNoA11yViolations(view.container, AXE);
    await click(within(c).getByRole('button', { name: 'Apply…' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/relaxes rules/)).toBeDefined();
    expect(within(dialog).getByRole('button', { name: 'Apply v4' }).className).toMatch(
      /destructive/,
    );
  });

  it('a version that tightens rules: Apply, Reject and Pin send theirs', async () => {
    const view = mount({
      ...list([linkedin({ pending: [pendingVersion()] })], onlineStatus(), 1),
      'GET /site-packs/linkedin.com/diff': packDiff(),
      'POST /site-packs/linkedin.com/reject': { view: linkedin() },
    });
    const c = await card(/LinkedIn/);
    expect(within(c).getAllByText('Tightens rules').length).toBeGreaterThan(0);
    await expectNoA11yViolations(view.container, AXE);
    await click(within(c).getByRole('button', { name: 'Reject' }));
    await waitFor(() =>
      expect(view.requests.find((r) => r.path.endsWith('/reject'))?.body).toEqual({ version: 4 }),
    );
  });

  it('a listed version: Download & review sends it, then shows the diff and focuses the card', async () => {
    let downloaded = false;
    const pending = () =>
      downloaded
        ? pendingVersion()
        : pendingVersion({ state: 'available', classification: 'unclassified' });
    const view = mount({
      'GET /site-packs': () =>
        packsResponse([linkedin({ pending: [pending()] })], {
          status: onlineStatus(),
          pending_count: 1,
        }),
      'POST /site-packs/linkedin.com/download': () => {
        downloaded = true;
        return { view: linkedin({ pending: [pendingVersion()] }), diff: packDiff() };
      },
      'GET /site-packs/linkedin.com/diff': packDiff(),
    });
    const c = await card(/LinkedIn/);
    expect(within(c).getByText('Not downloaded')).toBeDefined();
    expect(
      within(c).getByText(/the registry learns that your address downloaded this pack version/),
    ).toBeDefined();
    expect(within(c).queryByRole('button', { name: 'Apply…' })).toBeNull();
    await expectNoA11yViolations(view.container, AXE);
    await click(within(c).getByRole('button', { name: /Download & review/ }));
    await waitFor(() =>
      expect(view.requests.find((r) => r.path.endsWith('/download'))?.body).toEqual({ version: 4 }),
    );
    const after = await card(/LinkedIn/);
    expect(await within(after).findByText('guards[logout].action')).toBeDefined();
    expect(within(after).getByRole('button', { name: 'Apply…' })).toBeDefined();
    await waitFor(() =>
      expect(document.activeElement?.hasAttribute('data-card-heading')).toBe(true),
    );
  });

  it('revoked with a fallback: the decision is open; without one: kept, Turn off… offered', async () => {
    const open = mount({
      ...list(
        [
          linkedin({
            approved_revoked: true,
            pending: [pendingVersion({ version: 2, classification: 'revoked' })],
          }),
        ],
        onlineStatus(),
        1,
      ),
      'GET /site-packs/linkedin.com/diff': packDiff({ classification: 'revoked' }),
    });
    const c = await card(/LinkedIn/);
    expect(within(c).getByText(/The publisher revoked v3, the version in force/)).toBeDefined();
    expect(
      screen.getAllByText('Revoked by the publisher — still in force, review').length,
    ).toBeGreaterThan(0);
    await expectNoA11yViolations(open.container, AXE);
    open.unmount();
    const kept = mount(list([linkedin({ approved_revoked: true })], onlineStatus()));
    const k = await card(/LinkedIn/);
    expect(within(k).getByText(/lists no version to fall back to/)).toBeDefined();
    expect(within(k).getByRole('button', { name: 'Turn off…' })).toBeDefined();
    await expectNoA11yViolations(kept.container, AXE);
  });

  it('pinned: "Pinned at v3, v5 available", nothing waits in Updates', async () => {
    const view = mount(
      list(
        [
          linkedin({
            pinned_version: 3,
            pending: [
              pendingVersion({ version: 5, state: 'available', classification: 'unclassified' }),
            ],
          }),
        ],
        onlineStatus(),
      ),
    );
    expect((await screen.findAllByText('Pinned at v3, v5 available')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('heading', { name: /Updates available/ })).toBeNull();
    await expectNoA11yViolations(view.container, AXE);
  });

  it('auto-update on: the card says so and the auto-updated pack is marked', async () => {
    const view = mount(
      list(
        [
          linkedin({
            approved: {
              version: 3,
              sha256: sha('a'),
              source: 'remote',
              provenance: { kind: 'remote', key_id: 'k-2026a', index_version: 1412 },
              by: 'browserhive',
              at: 1_700_000_000_000 - 3_600_000,
            },
          }),
        ],
        onlineStatus({ auto_update: true }),
      ),
    );
    expect(
      await screen.findByText(/On: followed packs take updates that only tighten rules/),
    ).toBeDefined();
    expect(screen.getAllByText(/Auto-updated/).length).toBeGreaterThan(0);
    expect(screen.getAllByText('browserhive.ai registry').length).toBeGreaterThan(0);
    await expectNoA11yViolations(view.container, AXE);
  });
});

describe('registry actions', () => {
  it('Check now: sends the check and toasts its outcome', async () => {
    const view = mount({
      ...list([linkedin()]),
      'POST /site-packs/check': {
        outcome: 'updated',
        checked_at: 1,
        available: 2,
        status: onlineStatus({ index_version: 1413 }),
      },
    });
    await click(await screen.findByRole('button', { name: 'Check now' }));
    await waitFor(() => expect(view.requests.some((r) => r.path.endsWith('/check'))).toBe(true));
    expect((await screen.findAllByText('Index 1413 verified')).length).toBeGreaterThan(0);
  });

  it('Check now: a 429 waits with its reason', async () => {
    mount({
      ...list([linkedin()]),
      'POST /site-packs/check': {
        status: 429,
        body: {
          type: 'about:blank',
          title: 'Too many requests',
          status: 429,
          code: 'RATE_LIMITED',
          retryable: 'backoff',
          details: { retry_after_ms: 30_000 },
        },
      },
    });
    const button = await screen.findByRole('button', { name: 'Check now' });
    await click(button);
    expect((await screen.findAllByText('Checked too often')).length).toBeGreaterThan(0);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Check now' }).hasAttribute('disabled')).toBe(true),
    );
  });

  it('Download all: sends it and says what came', async () => {
    const view = mount({
      ...list([linkedin()]),
      'POST /site-packs/download-all': {
        downloaded: [{ pack_id: 'linkedin.com', version: 4, sha256: sha('c') }],
        held: 0,
        refused: [],
        pending_count: 1,
      },
    });
    await click(await screen.findByRole('button', { name: 'Download all' }));
    await waitFor(() =>
      expect(view.requests.some((r) => r.path.endsWith('/download-all'))).toBe(true),
    );
    expect((await screen.findAllByText('Downloaded 1 version')).length).toBeGreaterThan(0);
  });

  it('Apply selected: one confirmation listing what relaxes rules, then each version in turn', async () => {
    const github = packView({
      pack_id: 'github.com',
      title: 'GitHub',
      domains: ['github.com'],
      pending: [pendingVersion({ version: 7, classification: 'loosening' })],
    });
    const view = mount({
      ...list([linkedin({ pending: [pendingVersion()] }), github], onlineStatus(), 2),
      'GET /site-packs/linkedin.com/diff': packDiff(),
      'GET /site-packs/github.com/diff': packDiff({ classification: 'loosening' }),
      'POST /site-packs/linkedin.com/apply': { view: linkedin() },
      'POST /site-packs/github.com/apply': {
        view: packView({ pack_id: 'github.com', title: 'GitHub' }),
      },
    });
    await card(/GitHub/);
    for (const box of screen.getAllByRole('checkbox', { name: /Select/ })) await click(box);
    await click(screen.getByRole('button', { name: 'Apply 2 selected…' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/1 of them relax rules/)).toBeDefined();
    const items = within(dialog)
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    expect(items[0]).toContain('v7 · Relaxes rules');
    expect(items[1]).toContain('v3 → v4 · Tightens rules');
    await expectNoA11yViolations(document.body, AXE);
    await click(within(dialog).getByRole('button', { name: 'Apply 2 versions' }));
    await waitFor(() =>
      expect(view.requests.filter((r) => r.path.endsWith('/apply')).map((r) => r.path)).toEqual([
        '/api/v1/site-packs/linkedin.com/apply',
        '/api/v1/site-packs/github.com/apply',
      ]),
    );
  });

  it('Import… a signed folder: sends its files by path and shows what it became', async () => {
    const view = mount({
      ...list([linkedin()]),
      'POST /site-packs/import': {
        imported: [{ pack_id: 'linkedin.com', version: 4, state: 'downloaded', sha256: sha('c') }],
        layout: { outcome: 'updated', index_version: 1413, keys_version: 3, signed_by: 'k-2026a' },
      },
    });
    const input = (await screen.findByLabelText('Signed site pack folder')) as HTMLInputElement;
    const file = (path: string, text: string) => {
      const f = new File([text], path.split('/').at(-1) ?? path, { type: 'application/json' });
      Object.defineProperty(f, 'webkitRelativePath', { value: path });
      return f;
    };
    const files = [
      file('export-nov/keys.json', '{}'),
      file('export-nov/index.json', '{}'),
      file(`export-nov/packs/linkedin.com/${sha('c')}.json`, JSON.stringify(packContent())),
    ];
    await act(async () => {
      fireEvent.change(input, { target: { files } });
    });
    await waitFor(() => {
      const body = view.requests.find((r) => r.path.endsWith('/import'))?.body as {
        files: Record<string, string>;
        name: string;
      };
      expect(body.name).toBe('export-nov');
      expect(Object.keys(body.files).sort()).toEqual([
        'index.json',
        'keys.json',
        `packs/linkedin.com/${sha('c')}.json`,
      ]);
    });
    expect(await screen.findByText('Signed folder export-nov verified: index 1413')).toBeDefined();
    expect(screen.getByText('waits for review')).toBeDefined();
  });

  it('the Online and Imported chips go in the URL as registry and import', async () => {
    const view = mount(list([linkedin()]));
    await screen.findByRole('region', { name: 'Site packs' });
    await click(screen.getByRole('button', { name: /^Online/ }));
    await click(screen.getByRole('button', { name: /^Imported/ }));
    await waitFor(() =>
      expect(view.router.state.location.search).toMatchObject({ source: ['registry', 'import'] }),
    );
    await waitFor(() =>
      expect(
        view.requests.some(
          (r) => r.path === '/api/v1/site-packs' && r.query.get('source') === 'registry,import',
        ),
      ).toBe(true),
    );
  });

  it('a live status event updates the check line', async () => {
    let status = onlineStatus();
    const view = mount({
      'GET /site-packs': () => packsResponse([linkedin()], { status }),
    });
    await screen.findByText('up to date');
    view.connect();
    status = onlineStatus({ last_outcome: 'failed', failures: 1 });
    view.emit('site-packs', { type: 'site_pack.status', status });
    expect(await screen.findByText('failed')).toBeDefined();
  });
});

describe('the pack page', () => {
  it('lists a version of a pack nobody follows, with Download & review and the sources', async () => {
    const view = renderPage({
      path: '/site-packs/$id',
      component: SitePackPage,
      routes: {
        'GET /site-packs/changes': envelope([]),
        'GET /site-packs': packsResponse([], { status: onlineStatus() }),
        'GET /site-packs/linkedin.com': packDetail(
          linkedin({
            follow: { setting: 'off', effective: false },
            pending: [pendingVersion({ state: 'available', classification: 'unclassified' })],
          }),
        ),
      },
      url: '/site-packs/linkedin.com',
    });
    expect(await screen.findByText(/Not followed: these versions are not listed/)).toBeDefined();
    expect(screen.getByRole('button', { name: /Download & review/ })).toBeDefined();
    expect(screen.getByText('Bundled · Online')).toBeDefined();
    expect(screen.getByText(/Registry lists v4/)).toBeDefined();
    await expectNoA11yViolations(view.container, AXE);
  });
});

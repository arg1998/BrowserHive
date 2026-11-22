/** @module features/site-packs/review-100.test — regressions of the PR #100 UI review (review-pr100-ui.md): bidi and control characters in registry strings shown as U+FFFD (H1, the reviewer's RLO and ESC notes); "newer versions online · none followed" and the Follow note (M1); a first version compared with the bundled offer, or listed in full (M2); a set-aside version with Review again and the Reject/Revert copy (M4); focus after Apply, Reject, Pin and a failed download (M5); the `/templates` banner and the Sites-tab hint (M6); the import result's revoked and unfollowed entries (M7); a refused download on the card (L1); a readable failed-check reason (L2); no diff refetch of a decided version (L3); revoked first and without Pin (L4); new domains named in Apply (L5); signed-import provenance and the registry's own host (L12); what downloading reveals said once (L13) */
import { describe, expect, it } from 'bun:test';
import type { SitePackView } from '@browserhive/contracts/http';
import { printable } from '@/lib/format/printable.ts';
import {
  offeredPack,
  onlineStatus,
  packContent,
  packDetail,
  packDiff,
  packsResponse,
  packView,
  pendingVersion,
  sha,
} from '../../../test/fixtures/site-packs.ts';
import { templatesPage } from '../../../test/fixtures/templates.ts';
import { expectNoA11yViolations } from '../../../test/helpers/axe.ts';
import {
  envelope,
  type FakeRoute,
  problem,
  renderPage,
} from '../../../test/helpers/page-harness.tsx';
import { act, fireEvent, screen, waitFor, within } from '../../../test/helpers/render.tsx';
import { templatesSearch } from '../templates/search.ts';
import { TemplatesPage } from '../templates/TemplatesPage.tsx';
import { applyConfirm, revertConfirm } from './confirm-copy.ts';
import { SitePackPage } from './detail/SitePackPage.tsx';
import { provenanceText, registryName } from './model.ts';
import {
  checkErrorText,
  importCounts,
  importStateText,
  packUpdateHint,
  sentence,
} from './registry-model.ts';
import { SitePacksPage } from './SitePacksPage.tsx';
import { sitePacksSearch } from './search.ts';
import { pendingDecisions } from './UpdatesSection.tsx';

const AXE = { disable: ['aria-hidden-focus'] } as const;
const RLO = '‮';
const ESC = '\u001B';

function mount(routes: Record<string, FakeRoute>, url = '/site-packs') {
  return renderPage({
    path: '/site-packs',
    component: SitePacksPage,
    validateSearch: (s) => sitePacksSearch.parse(s),
    routes: { 'GET /templates': envelope([]), 'GET /site-packs/changes': envelope([]), ...routes },
    url,
  });
}

function packPage(routes: Record<string, FakeRoute>, id = 'linkedin.com') {
  return renderPage({
    path: '/site-packs/$id',
    component: SitePackPage,
    routes: {
      'GET /templates': envelope([]),
      'GET /site-packs/changes': envelope([]),
      'GET /site-packs': packsResponse([], { status: onlineStatus() }),
      ...routes,
    },
    url: `/site-packs/${id}`,
  });
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
  });
}

async function card(name: RegExp) {
  return (await screen.findByRole('heading', { level: 3, name })).closest('article') as HTMLElement;
}

const online = (patch: Partial<NonNullable<SitePackView['online']>> = {}) => ({
  version: 4,
  sha256: sha('c'),
  size: 6656,
  released: '2026-11-19',
  notes: 'x',
  revoked: false,
  needs_client: null,
  usable_version: 4,
  declined: false,
  ...patch,
});

describe('H1: registry strings are printable', () => {
  it('printable maps Cc/Cf/Zl/Zp to U+FFFD; multiline keeps line feeds', () => {
    expect(printable(`a${RLO}b${ESC}[31mc⁦d e`)).toBe('a�b�[31mc�d�e');
    expect(printable('one\ntwo', { multiline: true })).toBe('one\ntwo');
    expect(printable('one\ntwo')).toBe('one�two');
  });

  it("the reviewer's notes: RLO and ESC render as U+FFFD, never raw", async () => {
    const notes = `Tightens checkout guards. ${RLO}egnahc yfirev‬ ${ESC}]8;;https://evil.test${ESC}\\link`;
    const view = mount({
      'GET /site-packs': packsResponse(
        [
          packView({
            title: `Linked${RLO}nI`,
            online: online(),
            pending: [
              pendingVersion({ state: 'available', classification: 'unclassified', notes }),
            ],
          }),
        ],
        { status: onlineStatus(), pending_count: 1 },
      ),
    });
    const c = await card(/Linked/);
    const text = c.textContent ?? '';
    expect(text).not.toContain(RLO);
    expect(text).not.toContain(ESC);
    expect(text).not.toContain('‬');
    expect(text).toContain('Tightens checkout guards. �egnahc yfirev�');
    expect(text).toContain('Linked�nI');
    await expectNoA11yViolations(view.container, AXE);
  });

  it('confirm copy and provenance are printable too', () => {
    const pack = packView({ title: `X${RLO}Y` });
    expect(applyConfirm(pack, 4).title).toBe('Apply ⁨X�Y⁩ v4?');
    expect(provenanceText({ kind: 'import', file: `ex${RLO}port` }, 'import')).toBe(
      'Imported file ex�port',
    );
  });
});

describe('M1: newer versions nobody follows', () => {
  it('says "N newer versions online · none followed" and how to follow', async () => {
    const view = mount({
      'GET /site-packs': packsResponse(
        [
          packView({ online: online(), follow: { setting: 'auto', effective: false } }),
          offeredPack({ online: online({ version: 3, usable_version: 3 }) }),
        ],
        { status: onlineStatus(), pending_count: 0 },
      ),
    });
    expect(await screen.findByText('2 newer versions online · none followed')).toBeDefined();
    expect(screen.getByText(/turn Follow on to review one now/)).toBeDefined();
    expect(screen.queryByText('up to date')).toBeNull();
    await expectNoA11yViolations(view.container, AXE);
  });
});

describe('M2: a first version is compared with the bundled offer', () => {
  it('says what it is compared with; Apply lists what the version brings', async () => {
    const pack = offeredPack({
      follow: { setting: 'on', effective: true },
      pending: [
        pendingVersion({
          version: 3,
          classification: 'loosening',
          from: { version: 2, source: 'bundled' },
        }),
      ],
    });
    mount({
      'GET /site-packs': packsResponse([pack], { status: onlineStatus(), pending_count: 1 }),
      'GET /site-packs/github.com/diff': packDiff({
        from: { version: 2, sha256: sha('b'), source: 'bundled' },
        classification: 'loosening',
        changes: [{ path: 'guards[logout]', from: { id: 'logout' }, to: null, class: 'loosening' }],
      }),
    });
    const c = await card(/GitHub/);
    expect(
      within(c).getByText('Compared with bundled v2, which applies on first use.'),
    ).toBeDefined();
    expect(await within(c).findByText('guards[logout]')).toBeDefined();
    await click(within(c).getByRole('button', { name: 'Apply…' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(
      within(dialog).getByText(/Nothing is approved for this site yet. Compared with bundled v2/),
    ).toBeDefined();
    expect(within(dialog).getByText('What this version brings')).toBeDefined();
    expect(within(dialog).getByText(/guards\[logout\].* · Relaxes rules/)).toBeDefined();
  });

  it('a registry-only pack lists every field, those that relax rules first', async () => {
    const changes = Array.from({ length: 8 }, (_, i) => ({
      path: `field${i}`,
      from: null,
      to: i,
      class: i === 7 ? ('loosening' as const) : null,
    }));
    mount({
      'GET /site-packs': packsResponse(
        [
          offeredPack({
            offer: null,
            follow: { setting: 'on', effective: true },
            pending: [pendingVersion({ version: 1, classification: 'new_pack', from: null })],
          }),
        ],
        { status: onlineStatus(), pending_count: 1 },
      ),
      'GET /site-packs/github.com/diff': packDiff({
        from: null,
        classification: 'new_pack',
        changes,
      }),
    });
    const c = await card(/GitHub/);
    expect(
      within(c).getByText(/Only the registry lists this pack: every field below is new/),
    ).toBeDefined();
    const list = await within(c).findByRole('list', { name: 'Changed fields' });
    const items = within(list).getAllByRole('listitem');
    expect(items.length).toBe(8);
    expect(items[0]?.getAttribute('data-class')).toBe('loosening');
  });
});

describe('M4: a set-aside version', () => {
  it('the table says it; the pack page offers Review again, which downloads it', async () => {
    const pack = packView({ online: online({ declined: true }) });
    const view = mount({ 'GET /site-packs': packsResponse([pack], { status: onlineStatus() }) });
    expect((await screen.findAllByText('v4 set aside')).length).toBeGreaterThan(0);
    view.unmount();
    const page = packPage({
      'GET /site-packs/linkedin.com': packDetail(pack),
      'POST /site-packs/linkedin.com/download': {
        view: packView({ pending: [pendingVersion()] }),
        diff: packDiff(),
      },
    });
    await click(await screen.findByRole('button', { name: 'Review again' }));
    await waitFor(() =>
      expect(page.requests.find((r) => r.path.endsWith('/download'))?.body).toEqual({ version: 4 }),
    );
  });

  it('Revert says the version in force is set aside', () => {
    const copy = revertConfirm(packView({ previous: { version: 2, source: 'bundled' } }));
    expect(copy.description).toContain('v3 is set aside');
  });
});

describe('M5: focus after an action', () => {
  const two = () => [
    packView({ pending: [pendingVersion()] }),
    packView({
      pack_id: 'github.com',
      title: 'GitHub',
      domains: ['github.com'],
      pending: [pendingVersion({ version: 7 })],
    }),
  ];

  it('after Pin the next card heading has focus; after the last, the pack row', async () => {
    let packs = two();
    mount({
      'GET /site-packs': () =>
        packsResponse(packs, { status: onlineStatus(), pending_count: packs.length }),
      'GET /site-packs/linkedin.com/diff': packDiff(),
      'GET /site-packs/github.com/diff': packDiff(),
      'PUT /site-packs/linkedin.com/pin': () => {
        packs = [packs[1] as SitePackView, packView({ pinned_version: 3 })];
        return { view: packView({ pinned_version: 3, pending: [pendingVersion()] }) };
      },
      'PUT /site-packs/github.com/pin': () => {
        // Pinned: it leaves Updates available and stays in the table.
        packs = [
          packView({
            pack_id: 'github.com',
            title: 'GitHub',
            domains: ['github.com'],
            pinned_version: 3,
          }),
        ];
        return {
          view: packView({ pack_id: 'github.com', title: 'GitHub', pinned_version: 3 }),
        };
      },
    });
    await click(within(await card(/LinkedIn/)).getByRole('button', { name: 'Pin v3' }));
    await waitFor(() => expect(document.activeElement?.textContent).toMatch(/^GitHub/));
    expect(document.activeElement?.hasAttribute('data-card-heading')).toBe(true);
    await click(within(await card(/GitHub/)).getByRole('button', { name: 'Pin v3' }));
    // The pack's row in the table (its tab stop).
    await waitFor(() =>
      expect(
        document.activeElement?.getAttribute('href') ??
          document.activeElement?.querySelector('a[data-row-link]')?.getAttribute('href'),
      ).toBe('/site-packs/github.com'),
    );
  });

  it('a failed download keeps focus on its button', async () => {
    mount({
      'GET /site-packs': packsResponse(
        [packView({ online: online(), pending: [pendingVersion({ state: 'available' })] })],
        { status: onlineStatus(), pending_count: 1 },
      ),
      'POST /site-packs/linkedin.com/download': problem(502, 'SITE_PACK_DOWNLOAD_FAILED'),
    });
    const button = within(await card(/LinkedIn/)).getByRole('button', {
      name: /Download & review/,
    });
    button.focus();
    await click(button);
    await waitFor(() => expect(screen.getAllByText(/download/i).length).toBeGreaterThan(0));
    expect(document.activeElement).toBe(button);
    expect(button.hasAttribute('disabled')).toBe(false);
  });
});

describe('M6: template surfaces', () => {
  it('/templates shows the pending-updates banner linking to the filtered page', async () => {
    const view = renderPage({
      path: '/templates',
      component: TemplatesPage,
      validateSearch: (s) => templatesSearch.parse(s),
      routes: {
        'GET /templates': templatesPage([]),
        'GET /site-packs': packsResponse([], {
          status: onlineStatus(),
          pending_count: 2,
          local_needing_approval: 1,
        }),
      },
      url: '/templates',
    });
    expect(await screen.findByText('3 site pack updates wait for your review')).toBeDefined();
    expect(screen.getByRole('link', { name: 'Review updates' }).getAttribute('href')).toBe(
      '/site-packs?pending=1',
    );
    await expectNoA11yViolations(view.container, AXE);
  });

  it('the Sites tab hint per pack state', () => {
    expect(packUpdateHint(packView({ pending: [pendingVersion()] }))?.text).toBe(
      'v4 waiting for review',
    );
    expect(packUpdateHint(packView({ pinned_version: 3, online: online() }))?.text).toBe(
      'Pinned at v3, v4 available',
    );
    expect(packUpdateHint(packView({ approved_revoked: true }))?.text).toBe(
      'Revoked by the publisher',
    );
    expect(packUpdateHint(packView())).toBeNull();
  });
});

describe('M7: the import result', () => {
  it('revoked and unfollowed entries say what they are', async () => {
    expect(importStateText({ state: 'revoked' })).toBe('revoked by the publisher');
    expect(importStateText({ state: 'downloaded', followed: false })).toBe(
      'downloaded; turn Follow on to review it',
    );
    expect(
      importCounts({
        imported: [
          { pack_id: 'a.com', version: 2, state: 'downloaded', sha256: sha('a'), followed: false },
          { pack_id: 'b.com', version: 3, state: 'revoked', sha256: sha('b') },
        ],
      }),
    ).toBe('1 downloaded for a pack you don’t follow · 1 revoked by the publisher.');
    mount({
      'GET /site-packs': packsResponse([packView()], { status: onlineStatus() }),
      'POST /site-packs/import': {
        imported: [
          {
            pack_id: 'reddit.com',
            version: 4,
            state: 'downloaded',
            sha256: sha('c'),
            followed: false,
          },
        ],
        layout: { outcome: 'updated', index_version: 15, keys_version: 1, signed_by: 'k1' },
      },
    });
    const input = (await screen.findByLabelText('Signed site pack folder')) as HTMLInputElement;
    const file = new File(['{}'], 'keys.json', { type: 'application/json' });
    Object.defineProperty(file, 'webkitRelativePath', { value: 'export2/keys.json' });
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });
    expect(await screen.findByText('downloaded; turn Follow on to review it')).toBeDefined();
    expect(screen.getByRole('link', { name: /Open reddit\.com/ }).getAttribute('href')).toBe(
      '/site-packs/reddit.com',
    );
  });
});

describe('lows', () => {
  it('L1: a refused download shows on the card', async () => {
    mount({
      'GET /site-packs': packsResponse(
        [
          packView({
            online: online(),
            pending: [
              pendingVersion({
                state: 'available',
                refused: { reason: 'invalid_pack', detail: 'description: a format character' },
              }),
            ],
          }),
        ],
        { status: onlineStatus(), pending_count: 1 },
      ),
    });
    const c = await card(/LinkedIn/);
    expect(c.querySelector('[data-refused]')?.textContent).toBe(
      'Refused: invalid_pack description: a format character',
    );
  });

  it('L2: a failed check reads as a sentence, never the raw code', async () => {
    expect(checkErrorText({ code: 'http_status', message: 'keys.json: HTTP 503' })).toBe(
      'The registry answered with an error',
    );
    expect(sentence('keys.json: HTTP 503')).toBe('keys.json: HTTP 503.');
    mount({
      'GET /site-packs': packsResponse([packView()], {
        status: onlineStatus({
          last_outcome: 'failed',
          failures: 3,
          last_error: { code: 'http_status', message: 'keys.json: HTTP 503' },
        }),
      }),
    });
    const alert = (await screen.findByText('The last 3 update checks failed')).closest(
      '[role="alert"]',
    ) as HTMLElement;
    expect(alert.textContent).toContain(
      'The registry answered with an error. (keys.json: HTTP 503.) Nothing changed',
    );
    expect(screen.queryByText('http_status')).toBeNull();
  });

  it('L3: Apply does not refetch the diff of the version it decided', async () => {
    let applied = false;
    const view = mount({
      'GET /site-packs': () =>
        packsResponse([packView({ pending: applied ? [] : [pendingVersion()] })], {
          status: onlineStatus(),
          pending_count: applied ? 0 : 1,
        }),
      'GET /site-packs/linkedin.com/diff': packDiff(),
      'POST /site-packs/linkedin.com/apply': () => {
        applied = true;
        return { view: packView() };
      },
    });
    const c = await card(/LinkedIn/);
    await within(c).findByText('guards[logout].action');
    await click(within(c).getByRole('button', { name: 'Apply…' }));
    await click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Apply v4' }),
    );
    await waitFor(() => expect(view.requests.some((r) => r.path.endsWith('/apply'))).toBe(true));
    await waitFor(() =>
      expect(screen.queryByRole('heading', { level: 3, name: /LinkedIn/ })).toBeNull(),
    );
    const at = view.requests.findIndex((r) => r.path.endsWith('/apply'));
    expect(view.requests.slice(at).filter((r) => r.path.endsWith('/diff'))).toEqual([]);
  });

  it('L4: revoked decisions come first and offer no Pin', async () => {
    const decisions = pendingDecisions([
      packView({ pack_id: 'a.com', title: 'A', pending: [pendingVersion()] }),
      packView({ pack_id: 'b.com', title: 'B', approved_revoked: true }),
    ]);
    expect(decisions.map((d) => d.key)).toEqual(['b.com@revoked', 'a.com@4']);
    mount({
      'GET /site-packs': packsResponse(
        [
          packView({
            approved_revoked: true,
            pending: [pendingVersion({ version: 2, classification: 'revoked' })],
          }),
        ],
        { status: onlineStatus(), pending_count: 1 },
      ),
      'GET /site-packs/linkedin.com/diff': packDiff({ classification: 'revoked' }),
    });
    const c = await card(/LinkedIn/);
    expect(within(c).queryByRole('button', { name: /Pin/ })).toBeNull();
  });

  it('L5: Apply of a domains-only change names the new domains', () => {
    const copy = applyConfirm(packView(), 4, 'loosening', {
      diff: {
        new_domains: ['redd.it', 'redditstatic.com'],
        changes: [
          {
            path: 'domains',
            from: ['reddit.com'],
            to: ['reddit.com', 'redd.it'],
            class: 'loosening',
          },
        ],
      },
    });
    expect(copy.description).toContain('widens what the pack covers');
    expect(copy.description).not.toContain('weakens protections');
    expect(copy.items).toEqual(['New domains: ⁨redd.it⁩, ⁨redditstatic.com⁩']);
  });

  it('L12: a signed import names its key and index; the registry is its own host', () => {
    expect(
      provenanceText(
        { kind: 'import', file: 'export2', key_id: 'k1', index_version: 15 },
        'import',
      ),
    ).toBe('Imported file export2 · key k1 · signature verified · index 15');
    expect(registryName('https://mirror.example/registry/v1/')).toBe('mirror.example registry');
    expect(registryName('https://browserhive.ai/registry/v1/')).toBe('browserhive.ai registry');
    expect(
      provenanceText(
        { kind: 'remote', key_id: 'k1', index_version: 3 },
        'remote',
        'mirror.example registry',
      ),
    ).toBe('mirror.example registry · key k1 · signature verified · index 3');
  });

  it('L13: what downloading reveals is said once above several listed versions', async () => {
    mount({
      'GET /site-packs': packsResponse(
        [
          packView({ online: online(), pending: [pendingVersion({ state: 'available' })] }),
          packView({
            pack_id: 'github.com',
            title: 'GitHub',
            domains: ['github.com'],
            pending: [pendingVersion({ version: 7, state: 'available' })],
          }),
        ],
        { status: onlineStatus(), pending_count: 2 },
      ),
    });
    await card(/GitHub/);
    expect(screen.getAllByText(/the registry learns that your address downloaded/).length).toBe(1);
  });
});

void packContent;

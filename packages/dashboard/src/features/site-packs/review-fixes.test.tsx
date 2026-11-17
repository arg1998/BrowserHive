/** @module features/site-packs/review-fixes.test — regressions of the PR #83 review on the site-pack pages: a pack without write guards says its write policy has no effect (S-H3); pack strings render bidi-isolated (S-H4); a skipped pack names the pack that owns its domain and never talks of a local file it lacks (S-M1); Approve sends the hash of the diff on screen and waits when the file changed (S-M3); a local approval reads "local file" in History, keyed by event id (S-L4, C-I6); a pack without guards says so (S-N5); Import… sends the file's exact text */
import { describe, expect, it } from 'bun:test';
import {
  offeredPack,
  packContent,
  packDetail,
  packDiff,
  packsResponse,
  packView,
  sha,
} from '../../../test/fixtures/site-packs.ts';
import { envelope, type FakeRoute, renderPage } from '../../../test/helpers/page-harness.tsx';
import { act, fireEvent, screen, waitFor, within } from '../../../test/helpers/render.tsx';
import { SitePackPage } from './detail/SitePackPage.tsx';
import { reviewedSha } from './LocalApprovalCard.tsx';
import { NO_WRITE_GUARDS, skippedText } from './model.ts';
import { SitePacksPage } from './SitePacksPage.tsx';
import { sitePacksSearch } from './search.ts';

function packPage(routes: Record<string, FakeRoute>, id = 'linkedin.com') {
  return renderPage({
    path: '/site-packs/$id',
    component: SitePackPage,
    routes: { 'GET /site-packs/changes': envelope([]), ...routes },
    url: `/site-packs/${id}`,
  });
}

function listPage(routes: Record<string, FakeRoute>, url = '/site-packs') {
  return renderPage({
    path: '/site-packs',
    component: SitePacksPage,
    validateSearch: (s) => sitePacksSearch.parse(s),
    routes,
    url,
  });
}

const LOCAL = {
  path: '/data/site-packs/local/github.com.json',
  sha256: sha('d'),
  state: 'not_approved' as const,
  approved_sha256: null,
  problem: null,
};

describe('PR #83 review fixes: site-pack pages', () => {
  it('S-H3: a pack without write guards says its write policy has no effect', async () => {
    packPage({
      'GET /site-packs/linkedin.com': packDetail(packView({ write_guards: 0 })),
    });
    expect(await screen.findByText(/This pack guards no writes yet/)).toBeDefined();
    expect(NO_WRITE_GUARDS).toContain('has no effect');
    expect(screen.queryByText(/Each write waits until you approve it/)).toBeNull();
  });

  it('S-H4: pack strings render inside <bdi>, so a bidi override cannot reorder the copy around them', async () => {
    const title = 'GitHub ‮moc.buhtig';
    listPage({
      'GET /site-packs': packsResponse([offeredPack({ title, local: LOCAL })]),
      'GET /site-packs/github.com/diff': packDiff({ from: null }),
    });
    const heading = await screen.findByRole('heading', { level: 3, name: /GitHub/ });
    const isolated = [...heading.querySelectorAll('bdi')].map((b) => b.textContent);
    expect(isolated).toContain(title);
    // The label after the title is outside the isolate.
    expect(heading.querySelector('bdi')?.textContent).not.toContain('local file');
  });

  it('S-M1: a skipped pack names the owner of its domain and says nothing applies', async () => {
    const skipped = {
      version: 1,
      reason: 'domain_overlap' as const,
      detail: 'github.com belongs to the pack example.com',
    };
    expect(skippedText(skipped)).toBe(
      'v1 was skipped: Another pack already owns one of its domains (github.com belongs to the pack example.com).',
    );
    packPage(
      {
        'GET /site-packs/github.com': packDetail(offeredPack({ offer: null, skipped }), {
          versions: [],
        }),
      },
      'github.com',
    );
    expect(await screen.findByText('Not in force: none of the rules below apply')).toBeDefined();
    expect(screen.getAllByText(/belongs to the pack example\.com/).length).toBeGreaterThan(0);
    expect(screen.getByText('Not in force: no version of it can apply.')).toBeDefined();
    expect(screen.queryByText(/until its local file is approved/)).toBeNull();
  });

  it('S-M3: Approve sends the hash of the diff on screen, and waits when the file changed', async () => {
    expect(reviewedSha({ to: { sha256: sha('d') } }, false, sha('d'))).toBe(sha('d'));
    expect(reviewedSha({ to: { sha256: sha('d') } }, true, sha('d'))).toBeNull();
    expect(reviewedSha({ to: { sha256: sha('d') } }, false, sha('e'))).toBeNull();
    expect(reviewedSha(undefined, false, sha('d'))).toBeNull();
    // The list already says the file is `e`, the diff on screen is still `d`: no approval.
    listPage({
      'GET /site-packs': packsResponse([offeredPack({ local: { ...LOCAL, sha256: sha('e') } })]),
      'GET /site-packs/github.com/diff': packDiff({
        from: null,
        to: { version: 1, sha256: sha('d'), source: 'local' },
      }),
    });
    expect(await screen.findByText(/The file changed while you were looking/)).toBeDefined();
    const card = screen
      .getByRole('heading', { level: 3, name: /GitHub/ })
      .closest('article') as HTMLElement;
    expect(within(card).getByRole('button', { name: 'Approve…' }).hasAttribute('disabled')).toBe(
      true,
    );
    expect(within(card).getByRole('button', { name: 'Reload the changes' })).toBeDefined();
  });

  it('S-L4, C-I6: History reads "local file" for local content', async () => {
    listPage(
      {
        'GET /site-packs': packsResponse([packView()]),
        'GET /site-packs/changes': envelope([
          {
            seq: 7,
            event_id: 'e-LOCAL',
            pack_id: 'example.com',
            from_version: null,
            to_version: null,
            to_sha256: sha('f'),
            source: 'local',
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
    expect(within(list).getByText('local file')).toBeDefined();
    expect(within(list).queryByText(/v\?/)).toBeNull();
  });

  it('S-N5: a pack without guards says nothing is blocked', async () => {
    packPage({
      'GET /site-packs/linkedin.com': {
        ...packDetail(packView()),
        pack: packContent({ guards: [], element_guards: [] }),
      },
    });
    expect(await screen.findByText(/No guards: nothing on/)).toBeDefined();
  });

  it('Import… sends the file exactly as written, so its SHA-256 is the one verify prints', async () => {
    const view = listPage({
      'GET /site-packs': packsResponse([packView()]),
      'POST /site-packs/import': {
        imported: [{ pack_id: 'acme.com', version: 1, state: 'not_approved', sha256: sha('9') }],
      },
    });
    const text = '{\n  "schema": 1,\n  "id": "acme.com"\n}\n';
    const input = (await screen.findByLabelText('Site pack file')) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, {
        target: { files: [new File([text], 'acme.com.json', { type: 'application/json' })] },
      });
    });
    await waitFor(() =>
      expect(view.requests.find((r) => r.path.endsWith('/import'))?.body).toEqual({ text }),
    );
  });
});

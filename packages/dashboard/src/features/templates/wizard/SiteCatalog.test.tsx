/** @module features/templates/wizard/SiteCatalog.test — wizard step 2 with site packs (spec 13 §7.1, §9.6, T3a): the catalog of pack cards (title, domains, Sign in by hand only, the write policy, what the terms say, the version adding it approves with its provenance and short SHA-256), search, a whole card adds the site and says what it approves, a typed domain that has a pack says the same, and `POST /templates` carries each site's `pack_sha256` (the offer's or the approved version's); generic sites stay as before; axe clean */
import { beforeEach, describe, expect, it } from 'bun:test';
import { systemInfo } from '../../../../test/fixtures/ops.ts';
import {
  offeredPack,
  packsResponse,
  packView,
  registryStatus,
  sha,
} from '../../../../test/fixtures/site-packs.ts';
import { template, templateSite, tid } from '../../../../test/fixtures/templates.ts';
import { expectNoA11yViolations } from '../../../../test/helpers/axe.ts';
import { type RecordedRequest, renderPage } from '../../../../test/helpers/page-harness.tsx';
import { act, fireEvent, screen, waitFor, within } from '../../../../test/helpers/render.tsx';
import { wizardSearch } from '../search.ts';
import { DRAFT_KEY, EMPTY_DRAFT, removeSite, toTemplateInput } from './draft.ts';
import { NewTemplatePage } from './NewTemplatePage.tsx';

const ID = tid(8);

function mount(packs = packsResponse([packView({ human_only: true }), offeredPack()])) {
  localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...EMPTY_DRAFT, name: 'job-hunt' }));
  return renderPage({
    path: '/templates/new',
    component: NewTemplatePage,
    validateSearch: (s) => wizardSearch.parse(s),
    routes: {
      'GET /system': systemInfo({ auth_mode: 'off' }),
      'GET /notifications/report-settings': { host_time_zone: 'America/Toronto' },
      'GET /site-packs': packs,
      'POST /templates': (req: RecordedRequest) => {
        const body = req.body as { name: string; sites: { site_id: string }[] };
        return {
          status: 201,
          body: {
            template: template(8, {
              template_id: ID,
              name: body.name,
              status: 'recording',
              sites: body.sites.map((s) => templateSite(s.site_id)),
            }),
          },
        };
      },
    },
    url: '/templates/new?step=2',
  });
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
  });
}

beforeEach(() => localStorage.removeItem(DRAFT_KEY));

describe('wizard site catalog', () => {
  it('shows a card per pack, adds a site from its card and says what it approves; axe clean', async () => {
    const view = mount();
    const catalog = (
      await screen.findByRole('heading', { name: 'Sites BrowserHive knows' })
    ).closest('section') as HTMLElement;
    const linkedin = await within(catalog).findByRole('button', { name: 'Add LinkedIn' });
    expect(within(linkedin).getByText('Sign in by hand only')).toBeDefined();
    expect(within(linkedin).getByText('Writes: Confirm')).toBeDefined();
    expect(within(linkedin).getByText('The site’s terms prohibit automated access')).toBeDefined();
    expect(
      within(linkedin).getByText(
        `v3 · Bundled with BrowserHive 0.3.0 · SHA-256 ${sha('a').slice(0, 12)}…`,
      ),
    ).toBeDefined();
    const github = within(catalog).getByRole('button', { name: 'Add GitHub' });
    expect(within(github).getByText('The site’s terms allow automated access')).toBeDefined();
    await expectNoA11yViolations(view.container);

    // Search narrows the grid.
    fireEvent.change(within(catalog).getByLabelText('Search sites'), { target: { value: 'git' } });
    expect(within(catalog).queryByRole('button', { name: 'Add LinkedIn' })).toBeNull();
    fireEvent.change(within(catalog).getByLabelText('Search sites'), { target: { value: '' } });

    // The whole card adds the site; the chosen card says what creating the template approves.
    await click(within(catalog).getByRole('button', { name: 'Add GitHub' }));
    expect(within(catalog).getByRole('button', { name: 'GitHub: added' })).toBeDefined();
    expect(screen.getByText('GitHub · github.com')).toBeDefined();
    expect(
      screen.getByText(
        `Adding this site approves GitHub v2 (Bundled with BrowserHive 0.3.0, SHA-256 ${sha('b').slice(0, 12)}…).`,
      ),
    ).toBeDefined();

    // A typed domain with a pack says so before it is added; a generic one stays generic.
    fireEvent.change(screen.getByLabelText('Add another site'), {
      target: { value: 'https://www.linkedin.com/feed' },
    });
    expect(
      screen.getByText(/Uses LinkedIn v3 .* already approved for another template\./),
    ).toBeDefined();
    await click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.change(screen.getByLabelText('Add another site'), {
      target: { value: 'example.org' },
    });
    await click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText('BrowserHive learns its sign-in when you confirm it')).toBeDefined();
    await expectNoA11yViolations(view.container);

    // Create: each pack site carries the SHA-256 that was shown.
    await click(screen.getByRole('button', { name: /Next/ }));
    await screen.findByRole('heading', { level: 2, name: 'Identity and network' });
    await click(screen.getByRole('button', { name: 'Skip to sign-in' }));
    await waitFor(() => {
      const post = view.requests.find((r) => r.method === 'POST' && r.path === '/api/v1/templates');
      expect(post?.body).toMatchObject({
        sites: [
          { site_id: 'github.com', pack_sha256: sha('b') },
          { site_id: 'linkedin.com', pack_sha256: sha('a') },
          { site_id: 'example.org' },
        ],
      });
    });
  }, 20_000);

  it('keeps only the free-text add when site packs are off', async () => {
    mount(packsResponse([packView()], { status: registryStatus({ enabled: false }) }));
    expect(await screen.findByLabelText('Add a site')).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'Sites BrowserHive knows' })).toBeNull();
  });

  it('a removed site drops its pack choice', () => {
    const draft = { ...EMPTY_DRAFT, sites: ['github.com'], packs: { 'github.com': sha('b') } };
    expect(toTemplateInput(draft).sites).toEqual([
      { site_id: 'github.com', pack_sha256: sha('b') },
    ]);
    expect(removeSite(draft, 'github.com')).toMatchObject({ sites: [], packs: {} });
  });
});

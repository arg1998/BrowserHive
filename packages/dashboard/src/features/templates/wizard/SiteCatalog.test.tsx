/** @module features/templates/wizard/SiteCatalog.test — wizard step 2 with site packs (spec 13 §7.1, §9.6, T3a): the catalog of pack cards (title, domains, Sign in by hand only, the write policy, what the terms say, the version adding it approves with its provenance and short SHA-256), search, a whole card adds the site and says what it approves, and pressed again removes it with its pack choice (also when the template is full), a typed domain that has a pack says the same, and `POST /templates` carries each site's `pack_sha256` (the offer's or the approved version's); generic sites stay as before; axe clean */
import { beforeEach, describe, expect, it } from 'bun:test';
import { iso } from '@/features/site-packs/model.ts';
import { systemInfo } from '../../../../test/fixtures/ops.ts';
import {
  offeredPack,
  packDetail,
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
import { DRAFT_KEY, EMPTY_DRAFT, removeSite, SITES_MAX, toTemplateInput } from './draft.ts';
import { NewTemplatePage } from './NewTemplatePage.tsx';

const ID = tid(8);

function mount(
  packs: unknown = packsResponse([packView({ human_only: true }), offeredPack()]),
  options: { readonly sites?: readonly string[]; readonly step?: number } = {},
) {
  sessionStorage.setItem(
    DRAFT_KEY,
    JSON.stringify({ ...EMPTY_DRAFT, name: 'job-hunt', sites: options.sites ?? [] }),
  );
  return renderPage({
    path: '/templates/new',
    component: NewTemplatePage,
    validateSearch: (s) => wizardSearch.parse(s),
    routes: {
      'GET /system': systemInfo({ auth_mode: 'off' }),
      'GET /notifications/report-settings': { host_time_zone: 'America/Toronto' },
      'GET /site-packs': packs,
      'GET /site-packs/linkedin.com': packDetail(),
      'GET /site-packs/github.com': packDetail(offeredPack()),
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
    url: `/templates/new?step=${options.step ?? 2}`,
  });
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
  });
}

/** Let the page's remaining queries answer inside `act`. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

beforeEach(() => sessionStorage.removeItem(DRAFT_KEY));

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
    const githubOff = within(catalog).getByRole('button', { name: 'Add GitHub' });
    expect(githubOff.getAttribute('aria-pressed')).toBe('false');
    await click(githubOff);
    const githubOn = within(catalog).getByRole('button', { name: 'Remove GitHub' });
    expect(githubOn.getAttribute('aria-pressed')).toBe('true');
    expect(githubOn.hasAttribute('disabled')).toBe(false);
    expect(within(githubOn).getByText('Added')).toBeDefined();
    expect(
      screen.getByText(
        (_, el) => el?.textContent === 'GitHub · github.com' && el.tagName === 'SPAN',
      ),
    ).toBeDefined();
    expect(
      screen.getByText(
        `Adding this site approves ${iso('GitHub')} v2 (${iso('Bundled with BrowserHive 0.3.0')}, SHA-256 ${sha('b').slice(0, 12)}…).`,
      ),
    ).toBeDefined();

    // A typed domain with a pack says so before it is added; a generic one stays generic.
    fireEvent.change(screen.getByLabelText('Add a site'), {
      target: { value: 'https://www.linkedin.com/feed' },
    });
    expect(
      screen.getAllByText(
        /Uses \u2068LinkedIn\u2069 v3 .* already approved for another template\./,
      )[0],
    ).toBeDefined();
    await click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.change(screen.getByLabelText('Add a site'), {
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

  it('a site restored without its pack choice still sends the hash its card shows; Create waits for the catalog (review S-M4)', async () => {
    let release: (value: unknown) => void = () => undefined;
    const view = mount(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      { sites: ['linkedin.com'], step: 4 },
    );
    const create = await screen.findByRole('button', { name: 'Create and sign in' });
    expect(create.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('Loading the site catalog…')).toBeDefined();
    await act(async () => {
      release(packsResponse([packView()]));
    });
    await waitFor(() => expect(create.hasAttribute('disabled')).toBe(false));
    await click(create);
    await waitFor(() => {
      const post = view.requests.find((r) => r.method === 'POST' && r.path === '/api/v1/templates');
      expect(post?.body).toMatchObject({
        sites: [{ site_id: 'linkedin.com', pack_sha256: sha('a') }],
      });
    });
  });

  it('a chosen pack site shows the terms clause, sign in by hand only and an unguarded write policy (review S-L1, S-H3)', async () => {
    mount(packsResponse([packView({ human_only: true, write_guards: 0 })]), {
      sites: ['linkedin.com'],
    });
    const catalog = (
      await screen.findByRole('heading', { name: 'Sites BrowserHive knows' })
    ).closest('section') as HTMLElement;
    expect(within(catalog).getByText('Writes not guarded yet')).toBeDefined();
    const chosen = screen
      .getByRole('button', { name: 'Remove linkedin.com' })
      .closest('li') as HTMLElement;
    expect(within(chosen).getByText(/Sign in by hand only: you sign in yourself/)).toBeDefined();
    expect(within(chosen).getByText(/This pack guards no writes yet/)).toBeDefined();
    expect(await within(chosen).findByText(/will not use bots/)).toBeDefined();
    expect(within(chosen).getByText('Checked 2026-11-01')).toBeDefined();
  });

  it('keeps only the free-text add when site packs are off', async () => {
    mount(packsResponse([packView()], { status: registryStatus({ enabled: false }) }));
    expect(await screen.findByLabelText('Add a site')).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'Sites BrowserHive knows' })).toBeNull();
  });

  it('pressing an added card removes the site and its pack choice; axe clean', async () => {
    const view = mount();
    const catalog = (
      await screen.findByRole('heading', { name: 'Sites BrowserHive knows' })
    ).closest('section') as HTMLElement;
    await click(await within(catalog).findByRole('button', { name: 'Add GitHub' }));
    const chosen = screen
      .getByRole('button', { name: 'Remove github.com' })
      .closest('li') as HTMLElement;
    // The chosen card reads the pack's terms clause; let it load before going on.
    expect(await within(chosen).findByText(/^Checked /)).toBeDefined();
    expect(JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? '{}')).toMatchObject({
      sites: ['github.com'],
      packs: { 'github.com': sha('b') },
    });
    await expectNoA11yViolations(view.container);

    await click(within(catalog).getByRole('button', { name: 'Remove GitHub' }));
    const off = within(catalog).getByRole('button', { name: 'Add GitHub' });
    expect(off.getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByRole('button', { name: 'Remove github.com' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'No sites yet' })).toBeDefined();
    expect(JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? '{}')).toMatchObject({
      sites: [],
      packs: {},
    });
    await settle();
  });

  it('a full template still removes from a card, but adds nothing more', async () => {
    const sites = [
      'github.com',
      ...Array.from({ length: SITES_MAX - 1 }, (_, i) => `site${i}.example`),
    ];
    mount(undefined, { sites });
    const catalog = (
      await screen.findByRole('heading', { name: 'Sites BrowserHive knows' })
    ).closest('section') as HTMLElement;
    expect(
      screen.getByRole('heading', { name: `${SITES_MAX} of ${SITES_MAX} sites` }),
    ).toBeDefined();
    await click(within(catalog).getByRole('button', { name: 'Add LinkedIn' }));
    expect(within(catalog).getByRole('button', { name: 'Add LinkedIn' })).toBeDefined();
    await click(within(catalog).getByRole('button', { name: 'Remove GitHub' }));
    expect(within(catalog).getByRole('button', { name: 'Add GitHub' })).toBeDefined();
    expect(
      screen.getByRole('heading', { name: `${SITES_MAX - 1} of ${SITES_MAX} sites` }),
    ).toBeDefined();
    await settle();
  });

  it('a card with no version on offer cannot add, but removes a site already chosen', async () => {
    const noOffer = offeredPack({
      offer: null,
      local: {
        path: '/data/site-packs/local/github.com.json',
        sha256: sha('d'),
        state: 'not_approved',
        approved_sha256: null,
        problem: null,
      },
    });
    const first = mount(packsResponse([noOffer]));
    const catalog = async () =>
      (await screen.findByRole('heading', { name: 'Sites BrowserHive knows' })).closest(
        'section',
      ) as HTMLElement;
    const off = within(await catalog()).getByRole('button', { name: 'Add GitHub' });
    expect(off.hasAttribute('disabled')).toBe(true);
    expect(within(off).getByText('Approve its local file on Site packs first.')).toBeDefined();
    first.unmount();

    mount(packsResponse([noOffer]), { sites: ['github.com'] });
    const on = within(await catalog()).getByRole('button', { name: 'Remove GitHub' });
    expect(on.hasAttribute('disabled')).toBe(false);
    await click(on);
    expect(screen.getByRole('heading', { name: 'No sites yet' })).toBeDefined();
  });

  it('a removed site drops its pack choice', () => {
    const draft = { ...EMPTY_DRAFT, sites: ['github.com'], packs: { 'github.com': sha('b') } };
    expect(toTemplateInput(draft).sites).toEqual([
      { site_id: 'github.com', pack_sha256: sha('b') },
    ]);
    expect(removeSite(draft, 'github.com')).toMatchObject({ sites: [], packs: {} });
  });
});

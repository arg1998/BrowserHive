/** @module features/templates/wizard/SiteNeeds.test — a site pack's needs in the wizard (spec 13 §9.4 `stealth-profile`, §11.1, T3b): the chosen-site card shows the floor ("Needs stealth Max", "Fingerprint noise must be off"); step 3 leads with what the sites need, keeps Next from a refusal with the need under its control, fixes it in one click, and `POST /templates` then carries the setting; a server refusal for a floor the dashboard did not know shows under the setting on step 3; forced humanized input with stealth off is an advisory row (what is not applied, **Turn stealth on**) that never blocks Next; axe clean */
import { beforeEach, describe, expect, it } from 'bun:test';
import type { SitePackV1Input } from '@browserhive/contracts/site-packs';
import { systemInfo } from '../../../../test/fixtures/ops.ts';
import {
  offeredPack,
  packContent,
  packDetail,
  packsResponse,
  packView,
} from '../../../../test/fixtures/site-packs.ts';
import { template, templateSite, tid } from '../../../../test/fixtures/templates.ts';
import { expectNoA11yViolations } from '../../../../test/helpers/axe.ts';
import { type RecordedRequest, renderPage } from '../../../../test/helpers/page-harness.tsx';
import { act, fireEvent, screen, waitFor, within } from '../../../../test/helpers/render.tsx';
import { wizardSearch } from '../search.ts';
import { DRAFT_KEY, EMPTY_DRAFT } from './draft.ts';
import { NewTemplatePage } from './NewTemplatePage.tsx';

const ID = tid(9);
const FLOOR = { strategies: [{ id: 'stealth-profile' as const, params: { min_level: 'max' } }] };
const NO_NOISE = {
  id: 'github.com',
  title: 'GitHub',
  domains: ['github.com'],
  strategies: [{ id: 'stealth-profile' as const, params: { fingerprint: 'forbidden' } }],
};

function mount(
  options: {
    readonly sites?: readonly string[];
    readonly step?: number;
    readonly refuse?: boolean;
    readonly fingerprint?: boolean | null;
    readonly stealth?: 'off' | 'standard' | 'max' | null;
    /** GitHub's pack content (default: fingerprint noise forbidden). */
    readonly github?: Partial<SitePackV1Input>;
  } = {},
) {
  localStorage.setItem(
    DRAFT_KEY,
    JSON.stringify({
      ...EMPTY_DRAFT,
      name: 'job-hunt',
      sites: options.sites ?? [],
      fingerprint: options.fingerprint ?? null,
      stealth: options.stealth ?? null,
      access: 'all',
    }),
  );
  return renderPage({
    path: '/templates/new',
    component: NewTemplatePage,
    validateSearch: (s) => wizardSearch.parse(s),
    routes: {
      'GET /system': systemInfo({ auth_mode: 'off' }),
      'GET /notifications/report-settings': { host_time_zone: 'America/Toronto' },
      'GET /site-packs': packsResponse([packView(), offeredPack()]),
      'GET /site-packs/linkedin.com': { ...packDetail(packView()), pack: packContent(FLOOR) },
      'GET /site-packs/github.com': {
        ...packDetail(offeredPack()),
        pack: packContent(options.github ?? NO_NOISE),
      },
      'POST /templates': (req: RecordedRequest) => {
        if (options.refuse === true) {
          return {
            status: 400,
            body: {
              type: 'about:blank',
              title: 'Invalid template',
              status: 400,
              code: 'VALIDATION_FAILED',
              retryable: 'never',
              details: {
                issues: [
                  {
                    path: 'sites[0]',
                    code: 'stealth_below_floor',
                    message:
                      "LinkedIn needs stealth 'max' or higher (the template has 'standard').",
                  },
                ],
              },
            },
          };
        }
        const body = req.body as { name: string; sites: { site_id: string }[] };
        const created = template(9, {
          template_id: ID,
          name: body.name,
          status: 'recording',
          sites: body.sites.map((s) => templateSite(s.site_id)),
        });
        return { status: 201, body: { template: created } };
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

beforeEach(() => localStorage.removeItem(DRAFT_KEY));

describe('site pack needs in the wizard', () => {
  it('the chosen-site cards show each pack floor; axe clean', async () => {
    const view = mount({ sites: ['linkedin.com', 'github.com'] });
    const linkedin = (await screen.findByRole('button', { name: 'Remove linkedin.com' })).closest(
      'li',
    ) as HTMLElement;
    expect(await within(linkedin).findByText('Needs stealth Max')).toBeDefined();
    const github = screen.getByRole('button', { name: 'Remove github.com' }).closest('li');
    expect(
      await within(github as HTMLElement).findByText('Fingerprint noise must be off'),
    ).toBeDefined();
    await expectNoA11yViolations(view.container);
  });

  it('step 3 explains the floor, blocks Next, fixes it in one click, and the create carries it', async () => {
    const view = mount({ sites: ['linkedin.com', 'github.com'], step: 3, fingerprint: true });
    const panel = (await screen.findByRole('heading', { name: 'What your sites need' })).closest(
      'section',
    ) as HTMLElement;
    await within(panel).findByText('Hide automation: Max');
    expect(
      within(panel).getByText('Consistent fingerprint: off (the site flags fingerprint noise)'),
    ).toBeDefined();
    await expectNoA11yViolations(view.container);
    await click(screen.getByRole('button', { name: /Next/ }));
    expect(view.router.state.location.search).toMatchObject({ step: 3 });
    expect(screen.getByText('LinkedIn needs Hide automation set to Max.')).toBeDefined();
    expect(
      screen.getByText('GitHub flags fingerprint noise: turn Consistent fingerprint off.'),
    ).toBeDefined();
    await click(within(panel).getByRole('button', { name: 'Use Max for LinkedIn' }));
    await click(within(panel).getByRole('button', { name: 'Turn off for GitHub' }));
    // GitHub's stealth-profile also carries the default `standard` floor, met from the start.
    expect(within(panel).getAllByText('Met')).toHaveLength(3);
    expect(screen.queryByText('LinkedIn needs Hide automation set to Max.')).toBeNull();
    await expectNoA11yViolations(view.container);
    await click(screen.getByRole('button', { name: /Next/ }));
    await screen.findByRole('heading', { level: 2, name: 'Access' });
    await click(screen.getByRole('button', { name: 'Create and sign in' }));
    await waitFor(() =>
      expect(view.requests.some((r) => r.method === 'POST' && r.path === '/api/v1/templates')).toBe(
        true,
      ),
    );
    const post = view.requests.find((r) => r.method === 'POST' && r.path === '/api/v1/templates');
    // `false` is the server default (fixture): the draft leaves it out.
    expect(post?.body).toMatchObject({ stealth: 'max' });
    expect(post?.body).not.toHaveProperty('fingerprint');
  }, 20_000);

  it('forced humanized input with stealth off: an advisory need with Turn stealth on; Next is not blocked; axe clean', async () => {
    const humanize = { ...NO_NOISE, strategies: [{ id: 'humanize-input' as const, params: {} }] };
    const view = mount({ sites: ['github.com'], step: 3, stealth: 'off', github: humanize });
    const panel = (await screen.findByRole('heading', { name: 'What your sites need' })).closest(
      'section',
    ) as HTMLElement;
    await within(panel).findByText(
      'Humanized input needs stealth on (Hide automation Standard or Max)',
    );
    expect(within(panel).getByText(/With stealth off it is not applied/)).toBeDefined();
    expect(
      within(panel).getByText(
        'A site pack asks for a setting that’s off here. The template can still be created, without it.',
      ),
    ).toBeDefined();
    await expectNoA11yViolations(view.container);
    await click(within(panel).getByRole('button', { name: 'Turn stealth on for GitHub' }));
    expect(within(panel).getByText('Met')).toBeDefined();
    expect(within(panel).queryByText(/With stealth off it is not applied/)).toBeNull();
    expect(within(panel).getByText('These settings meet every site pack’s needs.')).toBeDefined();
    await expectNoA11yViolations(view.container);
  });

  it('the humanize advisory never keeps Next: the template is created with stealth off', async () => {
    const humanize = { ...NO_NOISE, strategies: [{ id: 'humanize-input' as const, params: {} }] };
    const view = mount({ sites: ['github.com'], step: 3, stealth: 'off', github: humanize });
    await screen.findByText('Humanized input needs stealth on (Hide automation Standard or Max)');
    await click(screen.getByRole('button', { name: /Next/ }));
    await screen.findByRole('heading', { level: 2, name: 'Access' });
    await click(screen.getByRole('button', { name: 'Create and sign in' }));
    await waitFor(() =>
      expect(view.requests.some((r) => r.method === 'POST' && r.path === '/api/v1/templates')).toBe(
        true,
      ),
    );
    const post = view.requests.find((r) => r.method === 'POST' && r.path === '/api/v1/templates');
    expect(post?.body).toMatchObject({ stealth: 'off' });
  }, 20_000);

  it('a floor refusal from the server lands on step 3 under Hide automation', async () => {
    // The site's pack has no floor the dashboard knows (a typed generic site), the server refuses.
    const view = mount({ sites: ['example.com'], step: 4, refuse: true });
    await click(await screen.findByRole('button', { name: 'Create and sign in' }));
    await waitFor(() => expect(view.router.state.location.search).toMatchObject({ step: 3 }));
    const alert = await screen.findByText(
      "LinkedIn needs stealth 'max' or higher (the template has 'standard').",
    );
    expect(alert.getAttribute('role')).toBe('alert');
    await expectNoA11yViolations(view.container);
  });
});

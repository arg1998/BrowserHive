/** @module features/templates/detail/SitePackRows.test — a site's pack on the Sites tab (spec 13 §9.3, §9.6, §11.4, T3a): title, version and source, Sign in by hand only, the terms' stance as a label with the clause, its date and address as text (never a link), the write policy select with "Pack default: Confirm" sending `write_policy`, rule counts linking to the pack, a stopped site's Clear stop, a generic site offered "Use the … site pack" with a confirmation naming the SHA-256 and the new health reasons; axe clean */
import { describe, expect, it } from 'bun:test';
import { iso } from '@/features/site-packs/model.ts';
import {
  offeredPack,
  packsResponse,
  sha,
  templateSitePack,
} from '../../../../test/fixtures/site-packs.ts';
import { TT0, templateDetail, templateSite, tid } from '../../../../test/fixtures/templates.ts';
import { expectNoA11yViolations } from '../../../../test/helpers/axe.ts';
import { renderPage } from '../../../../test/helpers/page-harness.tsx';
import { act, fireEvent, screen, waitFor, within } from '../../../../test/helpers/render.tsx';
import { pickOption } from '../../../../test/helpers/select.ts';
import { templatePageSearch } from '../search.ts';
import { TemplatePage } from './TemplatePage.tsx';

const ID = tid(3);
const AXE = { disable: ['aria-hidden-focus'] } as const;

const LINKEDIN = templateSite('linkedin.com', {
  title: 'LinkedIn',
  pack_id: 'linkedin.com',
  pack_version: 3,
  pack: templateSitePack({ human_only: true }),
  stopped_at: TT0 - 60_000,
  health: {
    state: 'challenged',
    checked_at: TT0 - 60_000,
    changed_at: TT0 - 60_000,
    reason: 'challenge:captcha',
    consecutive_inconclusive: 0,
  },
});
const GITHUB = templateSite('github.com', {
  health: {
    state: 'signed_out',
    checked_at: TT0 - 60_000,
    changed_at: TT0 - 60_000,
    reason: 'redirect',
    consecutive_inconclusive: 0,
  },
});

function mount() {
  return renderPage({
    path: '/templates/$id',
    component: TemplatePage,
    validateSearch: (s) => templatePageSearch.parse(s),
    routes: {
      'GET /system': { vault: { enabled: false, backend: null } },
      'GET /sessions': { data: [], page: { next_cursor: null, limit: 100 } },
      'GET /site-packs': packsResponse([offeredPack()]),
      [`GET /templates/${ID}`]: templateDetail({ sites: [LINKEDIN, GITHUB] }),
      [`PUT /templates/${ID}/sites/linkedin.com`]: { site: LINKEDIN },
      [`PUT /templates/${ID}/sites/github.com`]: { site: GITHUB },
      [`POST /templates/${ID}/sites/linkedin.com/clear-stop`]: {
        site: { ...LINKEDIN, stopped_at: null },
      },
    },
    url: `/templates/${ID}`,
  });
}

async function card(name: string): Promise<HTMLElement> {
  return (await screen.findByRole('heading', { level: 2, name })).closest('section') as HTMLElement;
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
  });
}

describe('Sites tab: site packs', () => {
  it('a pack without write guards says the write policy has no effect and turns the select off (review S-H3)', async () => {
    renderPage({
      path: '/templates/$id',
      component: TemplatePage,
      validateSearch: (s) => templatePageSearch.parse(s),
      routes: {
        'GET /system': { vault: { enabled: false, backend: null } },
        'GET /sessions': { data: [], page: { next_cursor: null, limit: 100 } },
        'GET /site-packs': packsResponse([]),
        [`GET /templates/${ID}`]: templateDetail({
          sites: [{ ...LINKEDIN, stopped_at: null, pack: templateSitePack({ write_guards: 0 }) }],
        }),
      },
      url: `/templates/${ID}`,
    });
    const linkedin = await card('LinkedIn');
    expect(within(linkedin).getByText(/This pack guards no writes yet/)).toBeDefined();
    expect(within(linkedin).queryByText(/Each write waits until you approve it/)).toBeNull();
    expect(
      within(linkedin).getByRole('combobox').hasAttribute('disabled') ||
        within(linkedin).getByRole('combobox').getAttribute('aria-disabled') === 'true' ||
        within(linkedin).getByRole('combobox').hasAttribute('data-disabled'),
    ).toBe(true);
  });

  it('shows the pack, the terms as text and the rule counts; axe clean', async () => {
    const view = mount();
    const linkedin = await card('LinkedIn');
    expect(within(linkedin).getByRole('link', { name: 'LinkedIn' }).getAttribute('href')).toBe(
      '/site-packs/linkedin.com',
    );
    expect(within(linkedin).getByText('v3')).toBeDefined();
    expect(within(linkedin).getByText('Bundled')).toBeDefined();
    expect(within(linkedin).getByText(/automatic re-login is unavailable/)).toBeDefined();
    expect(within(linkedin).getByText('The site’s terms prohibit automated access')).toBeDefined();
    expect(within(linkedin).getByText(/will not use bots/)).toBeDefined();
    expect(within(linkedin).getByText('Checked 2026-11-01')).toBeDefined();
    const url = within(linkedin).getByText('https://www.linkedin.com/legal/user-agreement');
    expect(url.closest('a')).toBeNull();
    expect(within(linkedin).getByText('Pack default: Confirm')).toBeDefined();
    expect(
      within(linkedin).getByRole('link', {
        name: '12 guards · 3 guarded controls · 4 security checks',
      }),
    ).toBeDefined();
    expect(
      within(linkedin).getByText('The site showed a captcha: clear it in the browser.'),
    ).toBeDefined();
    const github = await card('github.com');
    expect(within(github).getByText('The site sent the check to its sign-in page.')).toBeDefined();
    await expectNoA11yViolations(view.container, AXE);
  });

  it('the write policy select sends the choice, and the pack default clears it', async () => {
    const view = mount();
    const linkedin = await card('LinkedIn');
    await pickOption(within(linkedin).getByRole('combobox'), 'Allow');
    await waitFor(() =>
      expect(view.requests.find((r) => r.method === 'PUT')?.body).toEqual({
        write_policy: 'allow',
      }),
    );
  });

  it('Clear stop clears a stopped site', async () => {
    const view = mount();
    const linkedin = await card('LinkedIn');
    expect(within(linkedin).getByText('Stopped: agents can’t use this site')).toBeDefined();
    await click(within(linkedin).getByRole('button', { name: 'Clear stop: linkedin.com' }));
    await waitFor(() =>
      expect(view.requests.some((r) => r.path.endsWith('/sites/linkedin.com/clear-stop'))).toBe(
        true,
      ),
    );
  });

  it('offers the pack to a generic site with a confirmation naming the SHA-256', async () => {
    const view = mount();
    const github = await card('github.com');
    await click(await within(github).findByRole('button', { name: 'Use the GitHub site pack…' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(`SHA-256 ${sha('b')}`)).toBeDefined();
    expect(within(dialog).getByText(`v2 · ${iso('Bundled with BrowserHive 0.3.0')}`)).toBeDefined();
    await click(within(dialog).getByRole('button', { name: 'Use the pack' }));
    await waitFor(() =>
      expect(view.requests.find((r) => r.path.endsWith('/sites/github.com'))?.body).toEqual({
        pack_sha256: sha('b'),
      }),
    );
  });
});

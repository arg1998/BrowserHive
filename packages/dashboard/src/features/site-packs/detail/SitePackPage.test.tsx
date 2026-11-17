/** @module features/site-packs/detail/SitePackPage.test — `/site-packs/$id` (spec 13 §11.4, T3a): every section as text (sign-in address in full, the check, the terms clause with its date and address as text and never a link, guards with methods and types, guarded controls, checks, pacing with its vendor label and source, strategies as data), provenance and SHA-256, settings (Follow updates, Enabled, Revert… behind a confirmation), versions, a local file waiting for approval, history, 404; axe clean */
import { describe, expect, it } from 'bun:test';
import {
  packDetail,
  packDiff,
  packView,
  sha,
  strategiesResponse,
} from '../../../../test/fixtures/site-packs.ts';
import { expectNoA11yViolations } from '../../../../test/helpers/axe.ts';
import {
  envelope,
  type FakeRoute,
  problem,
  renderPage,
} from '../../../../test/helpers/page-harness.tsx';
import { act, fireEvent, screen, waitFor, within } from '../../../../test/helpers/render.tsx';
import { iso } from '../model.ts';
import { SitePackPage } from './SitePackPage.tsx';

const AXE = { disable: ['aria-hidden-focus'] } as const;

function mount(routes: Record<string, FakeRoute>) {
  return renderPage({
    path: '/site-packs/$id',
    component: SitePackPage,
    routes: {
      'GET /site-packs/changes': envelope([]),
      'GET /site-packs/strategies': strategiesResponse(),
      ...routes,
    },
    url: '/site-packs/linkedin.com',
  });
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
  });
}

describe('SitePackPage', () => {
  it('shows every section as text with provenance and versions; axe clean', async () => {
    const view = mount({ 'GET /site-packs/linkedin.com': packDetail() });
    expect(await screen.findByRole('heading', { level: 1, name: 'LinkedIn' })).toBeDefined();
    // Sign-in and the check: full addresses as text.
    expect(screen.getByText('https://www.linkedin.com/login')).toBeDefined();
    expect(screen.getByText('https://www.linkedin.com/feed/')).toBeDefined();
    expect(screen.getByText('www.linkedin.com/uas/login*')).toBeDefined();
    // Where the sign-in form posts (review #84 N4), as text.
    expect(screen.getByText('Sign-in form posts to')).toBeDefined();
    expect(screen.getByText('www.linkedin.com/checkpoint/lg/login-submit')).toBeDefined();
    // Terms: the stance as a label, the clause verbatim, its date and address as text, no link.
    expect(screen.getAllByText('The site’s terms prohibit automated access').length).toBe(1);
    expect(screen.getByText(/will not use bots or other automated methods/)).toBeDefined();
    expect(screen.getByText('Checked 2026-11-01')).toBeDefined();
    const clauseUrl = screen.getByText('https://www.linkedin.com/legal/user-agreement#dos');
    expect(clauseUrl.closest('a')).toBeNull();
    expect(document.querySelector('a[href^="https://www.linkedin.com"]')).toBeNull();
    // Guards with their methods and the default resource types, guarded controls, checks.
    const guards = screen.getByRole('table', { name: 'Guards' });
    expect(within(guards).getByText('www.linkedin.com/m/logout')).toBeDefined();
    expect(within(guards).getByText(/GET, POST/)).toBeDefined();
    expect(within(guards).getByText(/Every method · document, xhr, fetch, ping/)).toBeDefined();
    expect(within(guards).getByText('Write policy')).toBeDefined();
    const controls = screen.getByRole('table', { name: 'Guarded controls' });
    expect(controls.textContent).toContain('menuitem named “Sign Out”');
    expect(screen.getByRole('table', { name: 'Security checks' })).toBeDefined();
    // Pacing labelled vendor guidance with its source; strategies as data.
    expect(screen.getByText(/At most 100 per week/)).toBeDefined();
    expect(screen.getByText('(vendor guidance)')).toBeDefined();
    // Strategies as readable text: the title from the binary's table, the pack's value and the default.
    const strategies = await screen.findByRole('list', { name: 'Human dwell time parameters' });
    expect(within(strategies).getByText('800')).toBeDefined();
    expect(within(strategies).getByText(/Default 2500 · Allowed min_ms–20000/)).toBeDefined();
    // Provenance, SHA-256, versions.
    expect(screen.getAllByText('Bundled with BrowserHive 0.3.0').length).toBeGreaterThan(0);
    expect(screen.getAllByText(`${sha('a').slice(0, 12)}…`, { exact: false }).length).toBe(2);
    expect(screen.getByRole('heading', { name: 'In force' })).toBeDefined();
    expect(screen.getByRole('link', { name: 'tp-0000000001' })).toBeDefined(); // no template list in this test: the id stands in
    await expectNoA11yViolations(view.container, AXE);
  });

  it('Revert shows what going back changes before acting (review #84 L4)', async () => {
    const view = mount({
      'GET /site-packs/linkedin.com': packDetail(
        packView({ previous: { version: 2, source: 'bundled' } }),
      ),
      'GET /site-packs/linkedin.com/diff': packDiff({
        from: { version: 3, sha256: sha('a'), source: 'bundled' },
        to: { version: 2, sha256: sha('b'), source: 'bundled' },
        classification: 'loosening',
        changes: [{ path: 'guards[logout]', from: { id: 'logout' }, to: null, class: 'loosening' }],
      }),
      'POST /site-packs/linkedin.com/revert': { view: packView() },
    });
    await click(await screen.findByRole('button', { name: 'Revert to v2…' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(view.requests.find((r) => r.path.endsWith('/diff'))?.query.get('to')).toBe('2');
    expect(
      within(dialog).getByText(/v2 relaxes rules compared with the version in force/),
    ).toBeDefined();
    expect(within(dialog).getByText('guards[logout] · Relaxes rules')).toBeDefined();
    await expectNoA11yViolations(document.body, AXE);
    await click(within(dialog).getByRole('button', { name: 'Revert' }));
    await waitFor(() => expect(view.requests.some((r) => r.path.endsWith('/revert'))).toBe(true));
  });

  it('Revert refused below a template’s stealth floor explains it in a dialog (D-71)', async () => {
    mount({
      'GET /site-packs/linkedin.com': packDetail(
        packView({ previous: { version: 2, source: 'bundled' } }),
      ),
      'POST /site-packs/linkedin.com/revert': {
        status: 409,
        body: {
          type: 'about:blank',
          title: 'Templates below the pack’s stealth floor',
          status: 409,
          code: 'SITE_PACK_BELOW_FLOOR',
          retryable: 'after_operator',
          details: {
            pack_id: 'linkedin.com',
            version: 2,
            templates: [
              {
                template_id: 'tp-0000000001',
                name: 'sales',
                issues: [
                  {
                    code: 'stealth_below_floor',
                    message: "needs stealth 'max' or higher (the template has 'standard')",
                  },
                ],
              },
            ],
            templates_text: "'sales' needs stealth 'max' or higher",
          },
        },
      },
    });
    await click(await screen.findByRole('button', { name: 'Revert to v2…' }));
    await click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Revert' }),
    );
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/wasn’t reverted to v2/)).toBeDefined();
    expect(
      within(dialog)
        .getByRole('link', { name: 'Open the Sites tab of sales' })
        .getAttribute('href'),
    ).toBe('/templates/tp-0000000001?tab=sites');
    expect(
      within(dialog).getByText('Or keep the current version.', { exact: false }),
    ).toBeDefined();
    await click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('Revert and turning off ask first; Follow updates and Enabled send their settings', async () => {
    const view = mount({
      'GET /site-packs/linkedin.com': packDetail(
        packView({ previous: { version: 2, source: 'bundled' } }),
      ),
      'POST /site-packs/linkedin.com/revert': { view: packView() },
      'PUT /site-packs/linkedin.com/follow': { view: packView() },
      'POST /site-packs/linkedin.com/disable': { view: packView({ enabled: false }) },
    });
    await click(await screen.findByRole('button', { name: 'Revert to v2…' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(`Revert ${iso('LinkedIn')} to v2?`)).toBeDefined();
    await click(within(dialog).getByRole('button', { name: 'Revert' }));
    await waitFor(() => expect(view.requests.some((r) => r.path.endsWith('/revert'))).toBe(true));
    await click(screen.getByRole('button', { name: 'Off' }));
    await waitFor(() =>
      expect(view.requests.find((r) => r.path.endsWith('/follow'))?.body).toEqual({
        follow: false,
      }),
    );
    // Turning a pack off drops its guards for every template: it asks first (review S-M2).
    await click(screen.getByRole('switch'));
    const off = await screen.findByRole('alertdialog');
    expect(within(off).getByText(`Turn off ${iso('LinkedIn')}?`)).toBeDefined();
    expect(
      within(off).getByText(/1 template loses its sign-out, account and credential guards/),
    ).toBeDefined();
    expect(view.requests.some((r) => r.path.endsWith('/disable'))).toBe(false);
    await click(within(off).getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(view.requests.some((r) => r.path.endsWith('/disable'))).toBe(true));
  });

  it('shows a local file waiting for approval with its diff', async () => {
    mount({
      'GET /site-packs/linkedin.com': packDetail(
        packView({
          local_override: true,
          local: {
            path: '/data/site-packs/local/linkedin.com.json',
            sha256: sha('e'),
            state: 'changed',
            approved_sha256: sha('a'),
            problem: null,
          },
        }),
      ),
      'GET /site-packs/linkedin.com/diff': packDiff({ new_domains: ['lnkd.in'] }),
    });
    expect(await screen.findByRole('heading', { name: /Waiting for your review/ })).toBeDefined();
    expect(screen.getAllByText('Changed since approval — review').length).toBeGreaterThan(0);
    expect(screen.getByText(/approved content keeps applying/)).toBeDefined();
    expect(await screen.findByText('lnkd.in')).toBeDefined();
    expect(screen.getByText('Local file overrides v3')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Approve…' })).toBeDefined();
  });

  it('says when the pack does not exist', async () => {
    mount({
      'GET /site-packs/linkedin.com': problem(404, 'SITE_PACK_NOT_FOUND', 'Site pack not found'),
    });
    expect(await screen.findByText('Site pack not found')).toBeDefined();
    expect(screen.getByRole('link', { name: /Back to site packs/ })).toBeDefined();
  });
});

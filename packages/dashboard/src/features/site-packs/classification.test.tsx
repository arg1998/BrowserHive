/** @module features/site-packs/classification.test — classification in the Site packs UI (spec 13 §9.7, §11.4, T3b): every chip in words with an icon (never colour alone), the classified diff (fields that relax rules or can stop the site first and highlighted, counts per class, the candidate's meaning), the History column, a revoked decision, and Apply refused below a template's stealth floor explained in a dialog; axe clean */

import { describe, expect, it } from 'bun:test';
import type { SitePackChangeRow, SitePackDiffResponse } from '@browserhive/contracts/http';
import { SitePackClassification } from '@browserhive/contracts/http';
import {
  packDetail,
  packDiff,
  packsResponse,
  packView,
  sha,
} from '../../../test/fixtures/site-packs.ts';
import { expectNoA11yViolations } from '../../../test/helpers/axe.ts';
import { envelope, type FakeRoute, renderPage } from '../../../test/helpers/page-harness.tsx';
import { act, fireEvent, render, screen, waitFor, within } from '../../../test/helpers/render.tsx';
import { ClassificationChip } from './ClassificationChip.tsx';
import { bySeverity, CLASSIFICATION_INFO, classCounts } from './classification.ts';
import { DiffView } from './DiffView.tsx';
import { SitePackPage } from './detail/SitePackPage.tsx';
import { SitePacksPage } from './SitePacksPage.tsx';
import { sitePacksSearch } from './search.ts';

const AXE = { disable: ['aria-hidden-focus'] } as const;

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
  });
}

/** A loosening candidate with a field of every class (document order: neutral first). */
function mixedDiff(): SitePackDiffResponse {
  return packDiff({
    classification: 'loosening',
    new_domains: ['lnkd.in'],
    changes: [
      { path: 'title', from: 'LinkedIn', to: 'LinkedIn (2026)', class: 'neutral' },
      { path: 'write_policy.default', from: 'warn', to: 'confirm', class: 'tightening' },
      { path: 'browser.headed', from: 'any', to: 'required', class: 'restrictive' },
      { path: 'guards[logout]', from: { id: 'logout' }, to: null, class: 'loosening' },
      {
        path: 'domains',
        from: ['linkedin.com'],
        to: ['linkedin.com', 'lnkd.in'],
        class: 'loosening',
      },
      { path: 'description', from: null, to: 'Jobs', class: 'neutral' },
    ],
  });
}

describe('ClassificationChip', () => {
  it('names every classification in words with an icon; axe clean', async () => {
    const view = render(
      <div>
        {SitePackClassification.options.map((c) => (
          <ClassificationChip key={c} classification={c} />
        ))}
      </div>,
    );
    for (const c of SitePackClassification.options) {
      const chip = view.container.querySelector(`[data-classification="${c}"]`);
      expect(chip?.textContent).toBe(CLASSIFICATION_INFO[c].label);
      expect(chip?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    }
    expect(screen.getByText('Relaxes rules')).toBeDefined();
    expect(screen.getByText('Can stop the site')).toBeDefined();
    expect(screen.getByText('Tightens rules')).toBeDefined();
    await expectNoA11yViolations(view.container, AXE);
  });

  it('orders the strongest classes first and counts them', () => {
    const ordered = bySeverity(mixedDiff().changes).map((c) => c.path);
    expect(ordered).toEqual([
      'guards[logout]',
      'domains',
      'browser.headed',
      'write_policy.default',
      'title',
      'description',
    ]);
    expect(classCounts(mixedDiff().changes)).toEqual([
      { cls: 'loosening', count: 2 },
      { cls: 'restrictive', count: 1 },
      { cls: 'tightening', count: 1 },
      { cls: 'neutral', count: 2 },
    ]);
  });
});

describe('DiffView', () => {
  it('leads with what needs a careful look, highlighted, each field with its class; axe clean', async () => {
    const view = render(<DiffView diff={mixedDiff()} />);
    expect(screen.getAllByText('Relaxes rules').length).toBe(2); // the two fields (the card shows the candidate's)
    expect(
      screen.getByText(/2 relax rules · 1 can stop the site · 1 tightens rules · 2 change no rule/),
    ).toBeDefined();
    expect(screen.getByText(/Removes or weakens a protection/)).toBeDefined();
    const list = screen.getByRole('list', { name: 'Changed fields' });
    const rows = within(list).getAllByRole('listitem');
    // The first four, strongest first; the neutral ones behind "Show all".
    expect(rows.map((r) => r.getAttribute('data-class'))).toEqual([
      'loosening',
      'loosening',
      'restrictive',
      'tightening',
    ]);
    expect(rows[0]?.className).toContain('border-l-danger-solid');
    expect(rows[2]?.className).toContain('border-l-warn-solid');
    expect(rows[3]?.className).not.toContain('border-l-danger-solid');
    expect(within(list).getByText('browser.headed')).toBeDefined();
    expect(screen.getByText('New domains:')).toBeDefined();
    await expectNoA11yViolations(view.container, AXE);
    await click(screen.getByRole('button', { name: 'Show all 6 changes' }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(6);
  });

  it('shows no field classes for a new pack', () => {
    render(
      <DiffView
        diff={packDiff({
          from: null,
          classification: 'new_pack',
          changes: [{ path: 'title', from: null, to: 'LinkedIn', class: null }],
        })}
      />,
    );
    expect(screen.queryByText('Relaxes rules')).toBeNull();
    expect(screen.getByText('A new pack: all 1 fields are new')).toBeDefined();
  });
});

/** History rows for the pack page. */
function historyRow(patch: Partial<SitePackChangeRow>): SitePackChangeRow {
  return {
    seq: 1,
    event_id: 'ev-1',
    pack_id: 'linkedin.com',
    from_version: 3,
    to_version: 4,
    to_sha256: sha('c'),
    source: 'bundled',
    classification: 'loosening',
    new_domains: [],
    notes: null,
    decision: 'approved',
    decided_by: 'admin',
    created_at: 1_700_000_000_000,
    decided_at: 1_700_000_000_000,
    ...patch,
  };
}

describe('History', () => {
  it('shows each change’s classification beside its decision; axe clean', async () => {
    const view = renderPage({
      path: '/site-packs/$id',
      component: SitePackPage,
      routes: {
        'GET /site-packs/linkedin.com': packDetail(),
        'GET /site-packs/strategies': { data: [] },
        'GET /site-packs/changes': envelope([
          historyRow({}),
          historyRow({ seq: 2, event_id: 'ev-2', classification: 'new_pack', from_version: null }),
          historyRow({ seq: 3, event_id: 'ev-3', classification: 'unclassified' }),
        ]),
      },
      url: '/site-packs/linkedin.com',
    });
    const history = await screen.findByRole('region', { name: 'Pack history' });
    expect(await within(history).findByText('Relaxes rules')).toBeDefined();
    expect(within(history).getByText('New pack')).toBeDefined();
    expect(within(history).getByText('Not classified')).toBeDefined();
    await expectNoA11yViolations(view.container, AXE);
  });
});

/** The list page with one pending LinkedIn version of `classification`. */
function listWith(classification: SitePackClassification, routes: Record<string, FakeRoute> = {}) {
  const pending = {
    version: 4,
    sha256: sha('c'),
    state: 'downloaded' as const,
    size: 4096,
    released: null,
    notes: null,
    classification,
    source: 'bundled' as const,
    provenance: { kind: 'bundled' as const, release: '0.3.1' },
  };
  return renderPage({
    path: '/site-packs',
    component: SitePacksPage,
    validateSearch: (s) => sitePacksSearch.parse(s),
    routes: {
      'GET /site-packs': packsResponse([packView({ pending: [pending] })], { pending_count: 1 }),
      'GET /site-packs/linkedin.com/diff': mixedDiff(),
      'GET /templates': envelope([]),
      ...routes,
    },
    url: '/site-packs',
  });
}

describe('a pending version', () => {
  it('a revoked decision says the version in force was revoked', async () => {
    listWith('revoked');
    const card = (await screen.findByRole('heading', { level: 3, name: /LinkedIn/ })).closest(
      'article',
    ) as HTMLElement;
    expect(within(card).getByText('Revoked by the publisher')).toBeDefined();
    expect(within(card).getByText(/The publisher revoked v3, the version in force/)).toBeDefined();
    expect(within(card).queryByText('Update')).toBeNull();
  });

  it('Apply of a version that relaxes rules asks with care', async () => {
    listWith('loosening');
    const card = (await screen.findByRole('heading', { level: 3, name: /LinkedIn/ })).closest(
      'article',
    ) as HTMLElement;
    await click(within(card).getByRole('button', { name: 'Apply…' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(
      within(dialog).getByText(/This version relaxes rules: check every highlighted field/),
    ).toBeDefined();
  });

  it('Apply refused below a template’s stealth floor names it and what to change; axe clean', async () => {
    const refused = {
      status: 409,
      body: {
        type: 'about:blank',
        title: 'Templates below the pack’s stealth floor',
        status: 409,
        code: 'SITE_PACK_BELOW_FLOOR',
        retryable: 'after_operator',
        details: {
          pack_id: 'linkedin.com',
          version: 4,
          templates: [
            {
              template_id: 'tp-0000000001',
              name: 'sales',
              issues: [
                {
                  code: 'stealth_below_floor',
                  message: "needs stealth 'max' or higher (the template has 'standard')",
                },
                { code: 'fingerprint_required', message: 'needs fingerprint noise on' },
              ],
            },
          ],
          templates_text: "'sales' needs stealth 'max' or higher",
        },
      },
    };
    const view = listWith('restrictive', { 'POST /site-packs/linkedin.com/apply': refused });
    const card = (await screen.findByRole('heading', { level: 3, name: /LinkedIn/ })).closest(
      'article',
    ) as HTMLElement;
    await click(within(card).getByRole('button', { name: 'Apply…' }));
    await click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Apply v4' }),
    );
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/v4 wasn’t applied/)).toBeDefined();
    // Stealth is fixed for a template's life (review #84 M3): the fix is the site's Sites tab or a
    // new template, never the template's Settings.
    const link = within(dialog).getByRole('link', { name: 'Open the Sites tab of sales' });
    expect(link.getAttribute('href')).toBe('/templates/tp-0000000001?tab=sites');
    expect(dialog.querySelector('a[href*="tab=settings"]')).toBeNull();
    expect(dialog.textContent).not.toMatch(/Settings|Raise/);
    expect(
      within(dialog).getByText("Needs stealth 'max' or higher (the template has 'standard')."),
    ).toBeDefined();
    expect(
      within(dialog).getByText(
        'Turn the site off on this template, or create a new template with higher stealth and fingerprint noise on.',
      ),
    ).toBeDefined();
    expect(within(dialog).getByText(/can’t change after it is created/)).toBeDefined();
    expect(within(dialog).getByText(/Or reject the version/)).toBeDefined();
    await expectNoA11yViolations(document.body, AXE);
    // One close affordance (review #84 L5).
    const closes = within(dialog).getAllByRole('button', { name: 'Close' });
    expect(closes).toHaveLength(1);
    await click(closes[0] as HTMLElement);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // The card keeps saying why, and reopens the explanation.
    expect(
      within(card).getByText(/Not applied: a template is below this version’s stealth floor/),
    ).toBeDefined();
    await click(within(card).getByRole('button', { name: 'What to change' }));
    expect(await screen.findByRole('dialog')).toBeDefined();
    expect(view.requests.filter((r) => r.path.endsWith('/apply'))).toHaveLength(1);
  });
});

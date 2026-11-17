/** @module features/templates/detail/SiteStrategyNotes.test — the Sites tab's strategy notes (spec 13 §9.4, §11.4; D49, D50): a site whose pack asks for what the template or machine cannot apply gets one warning per note, titled and explained in the server's words; other sites none; the `either` probe's weaker signed-in reason is worded; axe clean */
import { describe, expect, it } from 'bun:test';
import { signedInSite, templateDetail, tid } from '../../../../test/fixtures/templates.ts';
import { expectNoA11yViolations } from '../../../../test/helpers/axe.ts';
import { renderPage } from '../../../../test/helpers/page-harness.tsx';
import { screen, within } from '../../../../test/helpers/render.tsx';
import { templatePageSearch } from '../search.ts';
import { STRATEGY_NOTE_TITLE } from './SiteStrategyNotes.tsx';
import { TemplatePage } from './TemplatePage.tsx';

const ID = tid(1);
const AXE = { disable: ['aria-hidden-focus'] } as const;
const HUMANIZE =
  'The LinkedIn site pack asks for humanized input (clicks and typing paced like a person). This template has stealth off, so input on the site stays native and instant.';
const FOCUS =
  'The LinkedIn site pack keeps one of the site’s tabs in focus at a time. On a headless browser on macOS or Windows, a tab that once got a click keeps real focus.';

function mount(sites: ReturnType<typeof signedInSite>[]) {
  return renderPage({
    path: '/templates/$id',
    component: TemplatePage,
    validateSearch: (s) => templatePageSearch.parse(s),
    routes: {
      'GET /system': { vault: { enabled: false, backend: null } },
      'GET /sessions': { data: [], page: { next_cursor: null, limit: 100 } },
      [`GET /templates/${ID}`]: templateDetail({ stealth: 'off', headless: true, sites }),
    },
    url: `/templates/${ID}`,
  });
}

describe('Sites tab: strategy notes', () => {
  it('warns on the site whose pack is not applied in full, in plain words; axe clean', async () => {
    const view = mount([
      {
        ...signedInSite('linkedin.com'),
        strategy_notes: [
          { code: 'humanize_needs_stealth', message: HUMANIZE },
          { code: 'single_focus_limited', message: FOCUS },
        ],
      },
      signedInSite('indeed.com'),
    ]);
    const card = (await screen.findByRole('heading', { level: 2, name: 'linkedin.com' })).closest(
      'section',
    ) as HTMLElement;
    const notes = within(card).getAllByRole('note');
    expect(notes).toHaveLength(2);
    expect(
      within(notes[0] as HTMLElement).getByText('Humanized input is not applied'),
    ).toBeDefined();
    expect(within(notes[0] as HTMLElement).getByText(HUMANIZE)).toBeDefined();
    expect(
      within(notes[1] as HTMLElement).getByText(STRATEGY_NOTE_TITLE.single_focus_limited),
    ).toBeDefined();
    expect(within(notes[1] as HTMLElement).getByText(FOCUS)).toBeDefined();
    const other = screen
      .getByRole('heading', { level: 2, name: 'indeed.com' })
      .closest('section') as HTMLElement;
    expect(within(other).queryByTestId('strategy-notes')).toBeNull();
    await expectNoA11yViolations(view.container, AXE);
  });

  it('words an `either` probe’s signed-in reason as a weaker sign', async () => {
    const site = signedInSite('reddit.com');
    const view = mount([{ ...site, health: { ...site.health, reason: 'no_redirect_settled' } }]);
    const card = (await screen.findByRole('heading', { level: 2, name: 'reddit.com' })).closest(
      'section',
    ) as HTMLElement;
    expect(
      within(card).getByText(/loaded and stayed put for a few seconds\. A weaker sign/),
    ).toBeDefined();
    expect(within(card).queryByTestId('strategy-notes')).toBeNull();
    await expectNoA11yViolations(view.container, AXE);
  });
});

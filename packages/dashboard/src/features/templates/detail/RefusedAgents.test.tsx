/** @module features/templates/detail/RefusedAgents.test — the Access tab's "Refused agents" (deferred D60): each refused client with its harness (and declared name), listing or launch, the rule that refused it, how often and when last; the operator copy; the empty state; a card per row on a phone; "Edit access rules" scrolls to the rule fields; axe clean */
import { describe, expect, it } from 'bun:test';
import {
  refusalRow,
  refusalsPage,
  templateDetail,
  tid,
} from '../../../../test/fixtures/templates.ts';
import { expectNoA11yViolations } from '../../../../test/helpers/axe.ts';
import { renderPage } from '../../../../test/helpers/page-harness.tsx';
import { act, fireEvent, screen, within } from '../../../../test/helpers/render.tsx';
import { templatePageSearch } from '../search.ts';
import { ACCESS_RULES_ID } from './RefusedAgents.tsx';
import { TemplatePage } from './TemplatePage.tsx';

const ID = tid(1);
const AXE = { disable: ['aria-hidden-focus'] } as const;

function mount(refusals: unknown) {
  return renderPage({
    path: '/templates/$id',
    component: TemplatePage,
    validateSearch: (s) => templatePageSearch.parse(s),
    routes: {
      [`GET /templates/${ID}`]: templateDetail(),
      [`GET /templates/${ID}/refusals`]: refusals,
      'GET /system': { vault: { enabled: false, backend: null } },
      'GET /sessions': { data: [], page: { next_cursor: null, limit: 100 } },
    },
    url: `/templates/${ID}?tab=access`,
  });
}

async function section(): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { name: 'Refused agents' });
  return heading.closest('section') as HTMLElement;
}

describe('Access tab: Refused agents', () => {
  it('lists each refused client with harness, what, why, times and last seen; axe clean', async () => {
    const view = mount(
      refusalsPage([
        refusalRow({ kind: 'launch', count: 3 }),
        refusalRow({
          principal: 'agent:scraper',
          harness: 'other',
          harness_declared: 'Nightly Scraper',
          reason: 'harness_not_allowed',
        }),
      ]),
    );
    const panel = await section();
    expect(
      within(panel).getByText('Agents your access rules refused. They saw no template.', {
        exact: false,
      }),
    ).toBeDefined();
    expect(
      within(panel).getByText(/To let one in, add its client under Who may use/),
    ).toBeDefined();
    const table = await within(panel).findByRole('table');
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((h) => h.textContent?.trim());
    expect(headers).toEqual(['Client', 'Harness', 'What', 'Refused by', 'Times', 'Last seen']);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.length).toBe(2);
    const first = within(rows[0] as HTMLElement);
    expect(first.getByText('agent:research')).toBeDefined();
    expect(first.getByText('Cursor')).toBeDefined();
    expect(first.getByText('Launch')).toBeDefined();
    expect(first.getByText('Not in Who may use')).toBeDefined();
    expect(first.getByText('3')).toBeDefined();
    const second = within(rows[1] as HTMLElement);
    expect(second.getByText('Nightly Scraper')).toBeDefined();
    expect(second.getByText('Listing')).toBeDefined();
    expect(second.getByText('Harness not allowed')).toBeDefined();
    await expectNoA11yViolations(view.container, AXE);
  });

  it('shows the empty state without a button; axe clean', async () => {
    const view = mount(refusalsPage([]));
    const panel = await section();
    expect(await within(panel).findByText('No agent refused')).toBeDefined();
    expect(within(panel).queryByRole('button', { name: 'Edit access rules' })).toBeNull();
    expect(within(panel).queryByText(/To let one in/)).toBeNull();
    await expectNoA11yViolations(view.container, AXE);
  });

  it('"Edit access rules" scrolls to the rule fields', async () => {
    mount(refusalsPage([refusalRow()]));
    const panel = await section();
    const target = document.getElementById(ACCESS_RULES_ID);
    expect(target).not.toBeNull();
    let scrolled = false;
    if (target !== null) {
      target.scrollIntoView = () => {
        scrolled = true;
      };
    }
    await act(async () => {
      fireEvent.click(await within(panel).findByRole('button', { name: 'Edit access rules' }));
    });
    expect(scrolled).toBe(true);
  });

  it('says only the newest rows are kept when the list is full', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => refusalRow({ principal: `agent:${i}` }));
    mount(refusalsPage(rows));
    const panel = await section();
    expect(
      await within(panel).findByText(/Only the 100 seen most recently are kept\./),
    ).toBeDefined();
  });
});

/** @module features/vault/tester/TesterPanel.test — URL-driven dry-run renders fill/blocked decisions with their reason chains and sends slug + normalised URL */
import { describe, expect, it } from 'bun:test';
import { expectNoA11yViolations } from '../../../../test/helpers/axe.ts';
import { envelope, renderPage } from '../../../../test/helpers/page-harness.tsx';
import { screen, waitFor, within } from '../../../../test/helpers/render.tsx';
import { bindingRow, groupRow } from '../fixtures.ts';
import { vaultSearch } from '../search.ts';
import { TesterPanel } from './TesterPanel.tsx';

describe('TesterPanel', () => {
  it('renders decisions and reason chains for the URL in the search', async () => {
    const { requests, container } = renderPage({
      path: '/vault',
      component: () => <TesterPanel unlocked />,
      validateSearch: (s) => vaultSearch.parse(s),
      url: '/vault?tab=tester&tester=github.com%2Flogin&slug=agent-1',
      routes: {
        'POST /vault/bindings/resolve': {
          would_fill: ['work.github'],
          blocked: [{ handle: 'mail.one', reason: 'origin_mismatch' }],
        },
        'GET /vault/bindings': envelope([
          bindingRow(),
          bindingRow({ handle: 'mail.one', item_name: 'Mail' }),
        ]),
        'GET /vault/groups': { data: [groupRow()], duplicates: [] },
      },
    });
    const fill = await screen.findByRole('listitem', { name: 'work.github: fill' });
    expect(within(fill).getByText('would fill')).toBeTruthy();
    const blocked = screen.getByRole('listitem', { name: 'mail.one: blocked' });
    expect(within(blocked).getByText('origin_mismatch')).toBeTruthy();
    const chain = within(blocked).getByRole('list', { name: 'Reason chain' });
    expect(within(chain).getByText('origin allow-list: fail')).toBeTruthy();
    expect(within(chain).getByText('fill gates: skipped')).toBeTruthy();
    expect(screen.getByText(/1 binding would fill on/)).toBeTruthy();
    await waitFor(() =>
      expect(requests.find((r) => r.method === 'POST')?.body).toEqual({
        url: 'https://github.com/login',
        session_slug: 'agent-1',
      }),
    );
    await expectNoA11yViolations(container);
  });
});

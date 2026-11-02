/** @module features/vault/tester/TesterPanel.test — URL-driven dry-run renders fill/blocked decisions with their reason chains and sends slug + normalised URL; the harness inputs (D-48) are sent, a harness refusal names its list, and unchecked harness lists get a note; axe */
import { describe, expect, it } from 'bun:test';
import { expectNoA11yViolations } from '../../../../test/helpers/axe.ts';
import { envelope, renderPage } from '../../../../test/helpers/page-harness.tsx';
import { act, fireEvent, screen, waitFor, within } from '../../../../test/helpers/render.tsx';
import { bindingRow, groupRow } from '../fixtures.ts';
import { vaultSearch } from '../search.ts';
import { TesterPanel } from './TesterPanel.tsx';

function renderTester(url: string, resolve: unknown) {
  return renderPage({
    path: '/vault',
    component: () => <TesterPanel unlocked />,
    validateSearch: (s) => vaultSearch.parse(s),
    url,
    routes: {
      'POST /vault/bindings/resolve': resolve as never,
      'GET /vault/bindings': envelope([
        bindingRow({ harnesses: ['opencode'] }),
        bindingRow({ handle: 'mail.one', item_name: 'Mail' }),
      ]),
      'GET /vault/groups': { data: [groupRow()], duplicates: [] },
    },
  });
}

describe('TesterPanel', () => {
  it('renders decisions and reason chains for the URL in the search', async () => {
    const { requests, container } = renderTester(
      '/vault?tab=tester&tester=github.com%2Flogin&slug=agent-1',
      {
        would_fill: ['work.github'],
        blocked: [{ handle: 'mail.one', reason: 'origin_mismatch' }],
        harness_lists_unchecked: [],
      },
    );
    const fill = await screen.findByRole('listitem', { name: 'work.github: fill' });
    expect(within(fill).getByText('would fill')).toBeTruthy();
    const blocked = screen.getByRole('listitem', { name: 'mail.one: blocked' });
    expect(within(blocked).getByText('origin_mismatch')).toBeTruthy();
    const chain = within(blocked).getByRole('list', { name: 'Reason chain' });
    expect(within(chain).getByText('origin allow-list: fail')).toBeTruthy();
    expect(within(chain).getByText('fill gates: skipped')).toBeTruthy();
    expect(screen.getByText(/1 binding would fill on/)).toBeTruthy();
    expect(screen.queryByText('Harness lists were not checked')).toBeNull();
    await waitFor(() =>
      expect(requests.find((r) => r.method === 'POST')?.body).toEqual({
        url: 'https://github.com/login',
        session_slug: 'agent-1',
      }),
    );
    await expectNoA11yViolations(container);
  });

  it('says when harness lists were not checked, and marks the harness gate', async () => {
    const { container } = renderTester('/vault?tab=tester&tester=github.com', {
      would_fill: ['work.github'],
      blocked: [{ handle: 'mail.one', reason: 'origin_mismatch' }],
      harness_lists_unchecked: ['work.github'],
    });
    expect(await screen.findByText('Harness lists were not checked')).toBeTruthy();
    expect(screen.getByText(/One binding has a harness list/)).toBeTruthy();
    const fill = screen.getByRole('listitem', { name: 'work.github: fill' });
    expect(within(fill).getByText('harness: skipped')).toBeTruthy();
    await expectNoA11yViolations(container);
  });

  it('sends the harness and declared name, and names the list that refused', async () => {
    const { requests, container } = renderTester(
      '/vault?tab=tester&tester=github.com&harness=codex&declared=Codex%20Nightly',
      {
        would_fill: [],
        blocked: [
          { handle: 'work.github', reason: 'harness_not_allowed', rule: 'binding' },
          { handle: 'mail.one', reason: 'origin_mismatch' },
        ],
        harness_lists_unchecked: [],
      },
    );
    const blocked = await screen.findByRole('listitem', { name: 'work.github: blocked' });
    expect(within(blocked).getByText('harness_not_allowed')).toBeTruthy();
    expect(within(blocked).getByText('harness: fail')).toBeTruthy();
    expect(screen.getByText('as Codex (declared "Codex Nightly")')).toBeTruthy();
    await waitFor(() =>
      expect(requests.find((r) => r.method === 'POST')?.body).toEqual({
        url: 'https://github.com/',
        harness: 'codex',
        harness_declared: 'Codex Nightly',
      }),
    );
    expect((screen.getByLabelText('Declared name') as HTMLInputElement).value).toBe(
      'Codex Nightly',
    );
    await expectNoA11yViolations(container);
  });

  it('puts the declared name in the URL on Test', async () => {
    const { requests } = renderTester('/vault?tab=tester', {
      would_fill: [],
      blocked: [],
      harness_lists_unchecked: [],
    });
    fireEvent.change(await screen.findByLabelText('Page URL or host'), {
      target: { value: 'github.com' },
    });
    fireEvent.change(screen.getByLabelText('Declared name'), {
      target: { value: '  Nightly Scraper ' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    });
    await waitFor(() =>
      expect(requests.find((r) => r.method === 'POST')?.body).toEqual({
        url: 'https://github.com/',
        harness_declared: 'Nightly Scraper',
      }),
    );
  });
});

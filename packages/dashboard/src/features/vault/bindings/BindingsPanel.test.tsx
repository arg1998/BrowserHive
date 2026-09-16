/** @module features/vault/bindings/BindingsPanel.test — create validation (handle grammar, required item), optimistic edit, visible rollback on `CONFLICT` showing the server version, confirmed delete */
import { describe, expect, it } from 'bun:test';
import { keys } from '@/lib/api/keys.ts';
import { envelope, renderPage } from '../../../../test/helpers/page-harness.tsx';
import { act, fireEvent, screen, waitFor, within } from '../../../../test/helpers/render.tsx';
import { bindingRow, groupRow } from '../fixtures.ts';
import { vaultSearch } from '../search.ts';
import { BindingsPanel } from './BindingsPanel.tsx';

function setup() {
  let rows = [bindingRow()];
  const seen: { cachedTitle: unknown }[] = [];
  const harness = renderPage({
    path: '/vault',
    component: () => <BindingsPanel unlocked />,
    validateSearch: (s) => vaultSearch.parse(s),
    url: '/vault',
    routes: {
      'GET /vault/bindings': () => envelope(rows),
      'GET /vault/groups': { data: [groupRow()], duplicates: [] },
      'GET /vault/items': envelope([]),
      'PUT /vault/bindings/work.github': () => {
        const cached = harness.client.getQueriesData<{ data: { title: string }[] }>({
          queryKey: keys.vault.bindings(),
        });
        seen.push({ cachedTitle: cached[0]?.[1]?.data[0]?.title });
        rows = [bindingRow({ title: 'Changed elsewhere', version: 3 })];
        return {
          status: 412,
          body: {
            type: 'about:blank',
            title: 'Conflict',
            status: 412,
            code: 'CONFLICT',
            retryable: 'different_args',
            details: { current_version: 3 },
          },
        };
      },
      'DELETE /vault/bindings/work.github': () => {
        rows = [];
        return { ok: true, removed: true };
      },
    },
  });
  return { ...harness, seen };
}

describe('BindingsPanel', () => {
  it('validates the handle grammar and the item name on create', async () => {
    const { requests } = setup();
    await screen.findAllByText('GitHub');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'New binding' }));
    });
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Handle'), { target: { value: 'Work/GitHub' } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save binding' }));
    });
    const alerts = await within(dialog).findAllByRole('alert');
    const text = alerts.map((a) => a.textContent).join(' | ');
    expect(text).toContain('Lowercase letters');
    expect(text).toContain('An item name is required');
    expect(within(dialog).getByLabelText('Handle').getAttribute('aria-invalid')).toBe('true');
    expect(requests.some((r) => r.method === 'PUT')).toBe(false);
  });

  it('applies an edit optimistically and rolls back visibly on CONFLICT with the server version', async () => {
    const { seen, requests } = setup();
    await screen.findAllByText('GitHub');
    await act(async () => {
      fireEvent.click(
        screen.getAllByRole('button', { name: 'Edit work.github' })[0] as HTMLElement,
      );
    });
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Title'), { target: { value: 'My title' } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save binding' }));
    });
    await waitFor(() => expect(seen.length).toBe(1));
    expect(seen[0]?.cachedTitle).toBe('My title');
    const alert = await screen.findByText('Edit to work.github was rolled back');
    const callout = alert.closest('[role="alert"]') as HTMLElement;
    expect(within(callout).getByText('3')).toBeTruthy();
    expect(within(callout).getByText('1')).toBeTruthy();
    expect((await screen.findAllByText('Changed elsewhere')).length).toBeGreaterThan(0);
    expect(screen.queryByText('My title')).toBeNull();
    const put = requests.find((r) => r.method === 'PUT');
    expect(put?.body).toMatchObject({ title: 'My title', item_name: 'GitHub Login' });
  });

  it('deletes only after confirmation', async () => {
    const { requests } = setup();
    await screen.findAllByText('GitHub');
    await act(async () => {
      fireEvent.click(
        screen.getAllByRole('button', { name: 'Delete work.github' })[0] as HTMLElement,
      );
    });
    const dialog = await screen.findByRole('alertdialog');
    expect(requests.some((r) => r.method === 'DELETE')).toBe(false);
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    });
    await waitFor(() => expect(requests.some((r) => r.method === 'DELETE')).toBe(true));
    expect(await screen.findByText('No bindings yet')).toBeTruthy();
  });
});

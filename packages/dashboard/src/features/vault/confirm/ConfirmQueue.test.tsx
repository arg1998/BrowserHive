/** @module features/vault/confirm/ConfirmQueue.test — approve is optimistic (row gone before the server answers) and rolls back visibly with an error toast on failure; deny sends the inline reason */
import { describe, expect, it } from 'bun:test';
import { requestRow } from '@/features/attention/fixtures.ts';
import { keys } from '@/lib/api/keys.ts';
import { expectNoA11yViolations } from '../../../../test/helpers/axe.ts';
import { envelope, renderPage } from '../../../../test/helpers/page-harness.tsx';
import { act, fireEvent, screen, waitFor, within } from '../../../../test/helpers/render.tsx';
import { useVaultConfirms } from '../api.ts';
import { ConfirmQueue } from './ConfirmQueue.tsx';

function Queue() {
  const confirms = useVaultConfirms();
  return <ConfirmQueue items={confirms.data?.data ?? []} />;
}

const confirmRow = requestRow({
  request_id: 'a-VVVVVVVVVVVV',
  kind: 'vault_confirm',
  mode: null,
  entry_name: 'work.github',
  reason: 'Fill GitHub login',
  tool: 'vault_fill',
  options: null,
});

function setup(fail: boolean) {
  let rows = [confirmRow];
  const cacheAtRequest: unknown[] = [];
  const harness = renderPage({
    path: '/vault',
    component: Queue,
    url: '/vault',
    routes: {
      'GET /vault/confirm': () => envelope(rows, { open_count: rows.length }),
      'POST /vault/confirm/a-VVVVVVVVVVVV/resolve': () => {
        cacheAtRequest.push(harness.client.getQueryData(keys.vault.confirms()));
        if (fail)
          return {
            status: 409,
            body: {
              type: 'about:blank',
              title: 'Confirm not open',
              status: 409,
              code: 'CONFIRM_NOT_OPEN',
              retryable: 'never',
            },
          };
        rows = [];
        return { ok: true, status: 'resolved' };
      },
    },
  });
  return { ...harness, cacheAtRequest };
}

describe('ConfirmQueue', () => {
  it('approves optimistically', async () => {
    const { cacheAtRequest, container } = setup(false);
    const row = await screen.findByRole('listitem', { name: 'Fill of work.github' });
    expect(within(row).getByText('vault_fill')).toBeTruthy();
    await expectNoA11yViolations(container);
    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: 'Approve' }));
    });
    await waitFor(() => expect(cacheAtRequest.length).toBe(1));
    expect((cacheAtRequest[0] as { data: unknown[] }).data).toEqual([]);
    await waitFor(() => expect(screen.getByText('No fills waiting')).toBeTruthy());
  });

  it('rolls the row back and shows the error code when the server refuses', async () => {
    const { cacheAtRequest } = setup(true);
    const row = await screen.findByRole('listitem', { name: 'Fill of work.github' });
    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: 'Approve' }));
    });
    await waitFor(() => expect(cacheAtRequest.length).toBe(1));
    expect((cacheAtRequest[0] as { data: unknown[] }).data).toEqual([]);
    expect(await screen.findByRole('listitem', { name: 'Fill of work.github' })).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText('Approve failed').length).toBeGreaterThan(0));
    expect(screen.getAllByText('CONFIRM_NOT_OPEN').length).toBeGreaterThan(0);
  });

  it('denies with the inline reason (Enter submits)', async () => {
    const { requests } = setup(false);
    const row = await screen.findByRole('listitem', { name: 'Fill of work.github' });
    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: 'Deny' }));
    });
    const reason = within(row).getByLabelText('Reason for denying');
    fireEvent.change(reason, { target: { value: 'wrong site' } });
    await act(async () => {
      fireEvent.submit(reason.closest('form') as HTMLFormElement);
    });
    await waitFor(() =>
      expect(
        requests.find((r) => r.method === 'POST' && r.path.includes('/vault/confirm/'))?.body,
      ).toEqual({ decision: 'deny', reason: 'wrong site' }),
    );
  });
});

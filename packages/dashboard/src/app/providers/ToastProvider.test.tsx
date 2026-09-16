/** @module app/providers/ToastProvider.test — live regions (status vs alert), error code token, action toasts persist */

import { describe, expect, it } from 'bun:test';
import { ToastStack } from '@/app/shell/ToastStack.tsx';
import { AppError } from '@/lib/api/errors.ts';
import { act, render, screen, waitFor } from '../../../test/helpers/render.tsx';
import { useToast } from './ToastProvider.tsx';

function Trigger() {
  const toast = useToast();
  return (
    <>
      <button type="button" onClick={() => toast.info({ title: 'Saved' })}>
        info
      </button>
      <button
        type="button"
        onClick={() =>
          toast.fromError(
            new AppError({
              code: 'SESSION_NOT_FOUND',
              status: 404,
              title: 'Session not found',
              retryable: 'never',
              requestId: 'r9',
            }),
          )
        }
      >
        error
      </button>
      <button
        type="button"
        onClick={() =>
          toast.warning({ title: 'Act', action: { label: 'Open', onClick: () => undefined } })
        }
      >
        action
      </button>
    </>
  );
}

describe('toasts', () => {
  it('announces info in a status region and errors in an alert region with a copyable code', async () => {
    render(
      <>
        <Trigger />
        <ToastStack />
      </>,
    );
    await act(async () => {
      screen.getByRole('button', { name: 'info' }).click();
      screen.getByRole('button', { name: 'error' }).click();
    });
    await waitFor(() =>
      expect(
        screen
          .getAllByRole('status', { hidden: true })
          .some((el) => el.textContent?.includes('Saved')),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(
        screen
          .getAllByRole('alert', { hidden: true })
          .some((el) => el.textContent?.includes('Session not found')),
      ).toBe(true),
    );
    expect(
      screen.getByRole('button', { name: 'Copy error code SESSION_NOT_FOUND', hidden: true }),
    ).toBeDefined();
    expect(screen.getByText('· req r9')).toBeDefined();
  });

  it('keeps actionable toasts and renders their button', async () => {
    render(
      <>
        <Trigger />
        <ToastStack />
      </>,
    );
    await act(async () => {
      screen.getByRole('button', { name: 'action' }).click();
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Open', hidden: true })).toBeDefined(),
    );
  });
});

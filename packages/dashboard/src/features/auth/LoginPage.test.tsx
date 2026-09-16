/** @module features/auth/LoginPage.test — empty submit validated on submit, document title, "Invalid password.", 429 countdown, axe clean */

import { describe, expect, it } from 'bun:test';
import { AuthProvider } from '@/app/providers/AuthProvider.tsx';
import { AppError } from '@/lib/api/errors.ts';
import type { FetchLike } from '@/lib/api/http.ts';
import { expectNoA11yViolations } from '../../../test/helpers/axe.ts';
import { act, fireEvent, render, screen, waitFor } from '../../../test/helpers/render.tsx';
import { LoginPage, loginErrorMessage } from './LoginPage.tsx';

function problem(status: number, code: string, details: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({ type: 'x', title: code, status, code, retryable: 'never', details }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

describe('LoginPage', () => {
  it('maps errors to operator-facing copy', () => {
    expect(
      loginErrorMessage(
        new AppError({ code: 'INVALID_CREDENTIALS', status: 401, title: 'x', retryable: 'never' }),
        0,
      ),
    ).toBe('Invalid password.');
    expect(
      loginErrorMessage(
        new AppError({ code: 'RATE_LIMITED', status: 429, title: 'x', retryable: 'backoff' }),
        7,
      ),
    ).toBe('Too many attempts. Try again in 7s.');
  });

  it('validates an empty password on submit, shows the invalid message and counts down after 429', async () => {
    let mode: 'login' | 'invalid' | 'limited' = 'login';
    const fetchImpl: FetchLike = async (input) => {
      if (String(input).endsWith('/auth/me')) return problem(401, 'UNAUTHORIZED');
      if (mode === 'invalid') return problem(401, 'INVALID_CREDENTIALS');
      if (mode === 'limited') return problem(429, 'RATE_LIMITED', { retry_after_ms: 2000 });
      return new Response(
        JSON.stringify({
          ok: true,
          must_change_password: false,
          session: { id_prefix: 'ab', expires_at: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const { container } = render(
      <AuthProvider fetch={fetchImpl}>
        <LoginPage />
      </AuthProvider>,
    );
    const button = screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(document.title).toBe('Sign in · BrowserHive');
    const password = screen.getByLabelText('Password') as HTMLInputElement;
    await waitFor(() => expect(document.activeElement).toBe(password));
    // An empty submit is reported next to the field and sends nothing.
    await act(async () => {
      fireEvent.click(button);
    });
    await waitFor(() =>
      expect(container.querySelector('#login-error')?.textContent).toBe('Enter the password.'),
    );
    fireEvent.change(password, { target: { value: 'secret' } });
    await waitFor(() => expect(container.querySelector('#login-error')).toBeNull());
    await expectNoA11yViolations(container);
    mode = 'invalid';
    await act(async () => {
      fireEvent.click(button);
    });
    await waitFor(() =>
      expect(container.querySelector('#login-error')?.textContent).toBe('Invalid password.'),
    );
    mode = 'limited';
    await act(async () => {
      fireEvent.click(button);
    });
    await waitFor(() =>
      expect(container.querySelector('#login-error')?.textContent).toMatch(
        /Too many attempts\. Try again in [12]s\./,
      ),
    );
    expect((screen.getByRole('button', { name: /Wait/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});

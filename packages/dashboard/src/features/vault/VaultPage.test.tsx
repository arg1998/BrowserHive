/** @module features/vault/VaultPage.test — disabled explainer on VAULT_NOT_CONFIGURED; locked backend shows the generic unlock form (trimmed token body, no master password); tabs are URL state; axe clean */
import { describe, expect, it } from 'bun:test';
import { expectNoA11yViolations } from '../../../test/helpers/axe.ts';
import { envelope, problem, renderPage } from '../../../test/helpers/page-harness.tsx';
import { act, fireEvent, screen, waitFor } from '../../../test/helpers/render.tsx';
import { bindingRow, OVERVIEW, SYSTEM_VAULT_ON } from './fixtures.ts';
import { vaultSearch } from './search.ts';
import { VaultPage } from './VaultPage.tsx';

const base = {
  path: '/vault',
  component: VaultPage,
  validateSearch: (s: Record<string, unknown>) => vaultSearch.parse(s),
};

describe('VaultPage', () => {
  it('explains how to enable the vault when it is not configured', async () => {
    renderPage({
      ...base,
      url: '/vault',
      routes: {
        'GET /system': SYSTEM_VAULT_ON,
        'GET /vault': problem(404, 'VAULT_NOT_CONFIGURED'),
      },
    });
    expect(await screen.findByText('Vault backend is off')).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Enable the vault' })).toBeTruthy();
    // The guide link goes to the website, never to GitHub.
    const guide = screen.getByRole('link', { name: /Read the vault guide/ });
    expect(guide.getAttribute('href')).toBe('https://browserhive.ai/docs/guide/vault/');
  });

  it('shows the disabled panel from /system without calling the vault endpoints', async () => {
    const { requests } = renderPage({
      ...base,
      url: '/vault',
      routes: { 'GET /system': { vault: { enabled: false, backend: null } } },
    });
    expect(await screen.findByText('Vault backend is off')).toBeTruthy();
    expect(requests.some((r) => r.path.startsWith('/api/v1/vault'))).toBe(false);
  });

  it('unlocks a locked backend with a pasted session token and keeps the tab in the URL', async () => {
    let unlocked = false;
    const { requests, router, container } = renderPage({
      ...base,
      url: '/vault?tab=bindings',
      routes: {
        'GET /system': SYSTEM_VAULT_ON,
        'GET /vault': () => ({ ...OVERVIEW, unlocked }),
        'GET /vault/status': () => ({ unlocked, checked_at: OVERVIEW.now }),
        'GET /vault/confirm': envelope([], { open_count: 0 }),
        'GET /vault/bindings': envelope([bindingRow()]),
        'GET /vault/groups': { data: [], duplicates: [] },
        'POST /vault/unlock': () => {
          unlocked = true;
          return { ok: true, unlocked: true };
        },
      },
    });
    expect(await screen.findByText('bitwarden · locked')).toBeTruthy();
    expect(screen.getByText('(required)')).toBeTruthy();
    const create = await screen.findByRole('button', { name: /New binding/ });
    expect((create as HTMLButtonElement).disabled).toBe(true);
    await expectNoA11yViolations(container);
    expect(screen.queryByLabelText(/Passphrase/)).toBeNull();
    expect(screen.queryByText(/master password/i)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Session token/), {
      target: { value: '  pasted-session-token\n' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    });
    await waitFor(() =>
      expect(requests.find((r) => r.path.endsWith('/vault/unlock'))?.body).toEqual({
        token: 'pasted-session-token',
      }),
    );
    expect(await screen.findByText('bitwarden · unlocked')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: 'Tester' }));
    });
    await waitFor(() => expect(router.state.location.search).toMatchObject({ tab: 'tester' }));
  });
});

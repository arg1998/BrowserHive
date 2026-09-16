/** @module features/vault/log/VaultLogPage.test — table + expanded detail render only whitelisted fields (a secret marker in `details` never reaches the DOM), filters in the query, not-enabled explainer */
import { describe, expect, it } from 'bun:test';
import { expectNoA11yViolations } from '../../../../test/helpers/axe.ts';
import { envelope, problem, renderPage } from '../../../../test/helpers/page-harness.tsx';
import { act, fireEvent, screen, waitFor, within } from '../../../../test/helpers/render.tsx';
import { accessRow, SYSTEM_VAULT_ON } from '../fixtures.ts';
import { vaultLogSearch } from './search.ts';
import { VaultLogPage } from './VaultLogPage.tsx';

const MARKER = 'SECRET-MARKER-7f3a';

describe('VaultLogPage', () => {
  it('never renders non-whitelisted payload fields', async () => {
    const row = {
      ...accessRow({
        result: 'origin_mismatch',
        origin_check: 'fail',
        reason: 'origin not allowed',
        details: {
          password: MARKER,
          reason: 'page origin evil.example',
          totp: MARKER,
          nested: { value: MARKER },
          allowed_origins: ['github.com'],
        },
      }),
      secret: MARKER,
    };
    const { container, requests } = renderPage({
      path: '/vault/log',
      component: VaultLogPage,
      validateSearch: (s) => vaultLogSearch.parse(s),
      url: '/vault/log?result=origin_mismatch&evaluate=off',
      routes: { 'GET /system': SYSTEM_VAULT_ON, 'GET /vault/log': envelope([row]) },
    });
    const table = await screen.findByRole('region', { name: 'Vault access log' });
    const tr =
      within(table)
        .getAllByRole('row')
        .find((r) => r.getAttribute('aria-expanded') !== null) ?? null;
    if (tr === null) throw new Error('row missing');
    await act(async () => {
      fireEvent.click(tr);
    });
    expect(tr.getAttribute('aria-expanded')).toBe('true');
    expect(await screen.findByText('page origin evil.example')).toBeTruthy();
    expect(screen.getAllByText('origin fail').length).toBeGreaterThan(0);
    expect(document.body.innerHTML).not.toContain(MARKER);
    const call = requests.find((r) => r.path.endsWith('/vault/log'));
    expect(call?.query.get('result')).toBe('origin_mismatch');
    expect(call?.query.get('evaluate')).toBe('off');
    expect(call?.query.get('sort')).toBe('ts');
    // DataTable puts aria-expanded on the expandable <tr> (shared component; reported in the B3 handoff).
    await expectNoA11yViolations(container);
  });

  it('shows the not-enabled explainer for VAULT_NOT_CONFIGURED', async () => {
    renderPage({
      path: '/vault/log',
      component: VaultLogPage,
      validateSearch: (s) => vaultLogSearch.parse(s),
      url: '/vault/log',
      extra: () => [],
      routes: {
        'GET /system': SYSTEM_VAULT_ON,
        'GET /vault/log': problem(404, 'VAULT_NOT_CONFIGURED'),
      },
    });
    await waitFor(() => expect(screen.getByText('Vault backend is off')).toBeTruthy());
  });
  it('subscribes to vault.access unfiltered and to the session topic when filtered', async () => {
    const topics = async (url: string) => {
      const view = renderPage({
        path: '/vault/log',
        component: VaultLogPage,
        validateSearch: (s) => vaultLogSearch.parse(s),
        url,
        routes: { 'GET /system': SYSTEM_VAULT_ON, 'GET /vault/log': envelope([]) },
      });
      await waitFor(() => expect(view.sockets.length).toBe(1));
      await act(async () => {
        view.connect();
      });
      return view.sockets[0]?.sentOfType('subscribe').map((f) => f['topic']) ?? [];
    };
    const unfiltered = await topics('/vault/log');
    expect(unfiltered).toContain('vault.access');
    const filtered = await topics('/vault/log?session=shop-a1b2c3d4');
    expect(filtered).toContain('session:shop-a1b2c3d4');
    expect(filtered).not.toContain('vault.access');
  });
});

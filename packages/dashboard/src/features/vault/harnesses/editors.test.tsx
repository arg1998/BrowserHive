/** @module features/vault/harnesses/editors.test — the Harnesses field inside both editors (D-48): the binding drawer and the group-policy form send `harnesses` in their PUT bodies (`null` for All harnesses), restricted rules show a chip in the bindings table and the folder header, and the editors stay accessible */
import { describe, expect, it } from 'bun:test';
import { expectNoA11yViolations } from '../../../../test/helpers/axe.ts';
import { envelope, renderPage } from '../../../../test/helpers/page-harness.tsx';
import { act, fireEvent, screen, waitFor, within } from '../../../../test/helpers/render.tsx';
import { BindingsPanel } from '../bindings/BindingsPanel.tsx';
import { bindingRow, groupRow } from '../fixtures.ts';
import { GroupsPanel } from '../groups/GroupsPanel.tsx';
import { vaultSearch } from '../search.ts';

const SEEN = {
  data: [
    {
      harness: 'opencode',
      label: 'OpenCode',
      declared: 'OpenCode',
      sessions: 3,
      last_seen_at: 1_700_000_000_000,
    },
  ],
  principals: 2,
  window: { since: 0, until: 1_700_000_000_000 },
  now: 1_700_000_000_000,
};

describe('binding editor', () => {
  it('restricts a binding to harnesses and shows it in the table', async () => {
    let rows = [bindingRow()];
    const { requests, container } = renderPage({
      path: '/vault',
      component: () => <BindingsPanel unlocked />,
      validateSearch: (s) => vaultSearch.parse(s),
      url: '/vault',
      routes: {
        'GET /vault/bindings': () => envelope(rows),
        'GET /vault/groups': { data: [groupRow()], duplicates: [] },
        'GET /vault/items': envelope([]),
        'GET /vault/harnesses': SEEN,
        'PUT /vault/bindings/work.github': (request: { body: unknown }) => {
          const body = request.body as { harnesses?: string[] | null };
          rows = [
            bindingRow({
              version: 2,
              ...(body.harnesses !== null &&
                body.harnesses !== undefined && {
                  harnesses: body.harnesses,
                }),
            }),
          ];
          return { ok: true, binding: rows[0] };
        },
      },
    });
    await screen.findAllByText('GitHub');
    await act(async () => {
      fireEvent.click(
        screen.getAllByRole('button', { name: 'Edit work.github' })[0] as HTMLElement,
      );
    });
    const dialog = await screen.findByRole('dialog');
    const field = within(dialog).getByRole('group', { name: 'Harnesses' });
    expect(
      within(field).getByRole('button', { name: 'All harnesses' }).getAttribute('aria-pressed'),
    ).toBe('true');
    await within(field).findByRole('button', { name: /^OpenCode \(seen recently\)/ });
    fireEvent.click(within(field).getByRole('button', { name: /^OpenCode/ }));
    fireEvent.click(within(field).getByRole('button', { name: /^Claude Code/ }));
    await expectNoA11yViolations(container);
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save binding' }));
    });
    await waitFor(() => expect(requests.some((r) => r.method === 'PUT')).toBe(true));
    const put = requests.find((r) => r.method === 'PUT');
    expect(put?.body).toMatchObject({ harnesses: ['opencode', 'claude-code'] });
    expect((await screen.findAllByText('OpenCode, Claude Code')).length).toBeGreaterThan(0);
  });
});

describe('group policy editor', () => {
  it('saves a folder harness list, and All harnesses as null', async () => {
    const puts: unknown[] = [];
    let policy = groupRow()['policy'] as Record<string, unknown>;
    const { container } = renderPage({
      path: '/vault',
      component: () => <GroupsPanel unlocked />,
      validateSearch: (s) => vaultSearch.parse(s),
      url: '/vault?tab=groups&folder=g-work',
      routes: {
        'GET /vault/groups': () => ({ data: [groupRow({ policy })], duplicates: [] }),
        'GET /vault/harnesses': SEEN,
        'PUT /vault/groups/g-work/policy': (request: { body: unknown }) => {
          puts.push(request.body);
          const body = request.body as { harnesses: string[] | null };
          const { harnesses: _old, ...rest } = policy;
          policy = {
            ...rest,
            version: 3,
            ...(body.harnesses !== null && { harnesses: body.harnesses }),
          };
          return { ok: true, policy };
        },
      },
    });
    const field = await screen.findByRole('group', { name: 'Harnesses' });
    fireEvent.click(within(field).getByRole('button', { name: /^OpenCode/ }));
    fireEvent.click(within(field).getByRole('button', { name: /^Unknown/ }));
    await expectNoA11yViolations(container);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save group policy' }));
    });
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toMatchObject({ access_mode: 'manual', harnesses: ['opencode', 'unknown'] });
    expect(await screen.findByText('OpenCode, Unknown')).toBeTruthy();

    const reopened = await screen.findByRole('group', { name: 'Harnesses' });
    fireEvent.click(within(reopened).getByRole('button', { name: 'All harnesses' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save group policy' }));
    });
    await waitFor(() => expect(puts).toHaveLength(2));
    expect(puts[1]).toMatchObject({ harnesses: null });
  });

  it('hides the field while the folder rejects every fill', async () => {
    renderPage({
      path: '/vault',
      component: () => <GroupsPanel unlocked />,
      validateSearch: (s) => vaultSearch.parse(s),
      url: '/vault?tab=groups&folder=g-work',
      routes: {
        'GET /vault/groups': {
          data: [
            groupRow({
              policy: { ...(groupRow()['policy'] as object), access_mode: 'reject_all' },
            }),
          ],
          duplicates: [],
        },
        'GET /vault/harnesses': SEEN,
      },
    });
    await screen.findByRole('button', { name: 'Save group policy' });
    expect(screen.queryByRole('group', { name: 'Harnesses' })).toBeNull();
  });
});

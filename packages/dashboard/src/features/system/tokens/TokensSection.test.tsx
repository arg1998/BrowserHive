/** @module features/system/tokens/TokensSection.test — token list (never / prefix copy), empty state, create shows the plaintext once and purges it on close, snippets carry origin + token, revoke confirm with optimistic removal and rollback, 403 disabled state, axe clean */

import { describe, expect, it } from 'bun:test';
import type { ApiTokenSummary } from '@browserhive/contracts/http';
import { expectNoA11yViolations } from '../../../../test/helpers/axe.ts';
import {
  problem,
  type RecordedRequest,
  renderPage,
} from '../../../../test/helpers/page-harness.tsx';
import { act, fireEvent, screen, waitFor, within } from '../../../../test/helpers/render.tsx';
import { curlSnippet, mcpConfigSnippet } from './snippets.ts';
import { agentOrigin, TokensSection } from './TokensSection.tsx';

const NOW = 1_700_000_000_000;
const PLAINTEXT = `bh_agent_${'Q'.repeat(20)}secretTail${'z'.repeat(13)}`;

function token(n: number, overrides: Partial<ApiTokenSummary> = {}): ApiTokenSummary {
  return {
    credential_id: `cred-${n}`,
    public_prefix: `pfx${n}abcd`.slice(0, 8),
    owner_kind: 'agent',
    subject: `agent-${n}`,
    scopes: ['mcp:tools'],
    created_at: NOW - 3_600_000 * n,
    last_used_at: n === 1 ? NOW - 60_000 : null,
    expires_at: null,
    ...overrides,
  };
}

interface ServerOptions {
  readonly rows?: ApiTokenSummary[];
  readonly list?: unknown;
  readonly failRevoke?: boolean;
  readonly gate?: Promise<void>;
}

function mount(options: ServerOptions = {}) {
  const rows = options.rows ?? [token(1), token(2)];
  const view = renderPage({
    path: '/system',
    component: () => <TokensSection />,
    routes: {
      'GET /auth/tokens': options.list ?? (() => ({ data: [...rows] })),
      'POST /auth/tokens': (req: RecordedRequest) => {
        const body = req.body as { display: string };
        rows.push(token(3, { credential_id: 'cred-new', subject: body.display }));
        return { credential_id: 'cred-new', token: PLAINTEXT };
      },
      'DELETE /auth/tokens/cred-1': async () => {
        await options.gate;
        if (options.failRevoke === true) return problem(500, 'INTERNAL_ERROR', 'Internal error');
        rows.splice(
          rows.findIndex((r) => r.credential_id === 'cred-1'),
          1,
        );
        return { ok: true };
      },
    },
    url: '/system',
  });
  return view;
}

/** Real-timer poll: RTL `waitFor` stalls in happy-dom while a mutation request is held open. */
async function poll(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = performance.now();
  while (!check()) {
    if (performance.now() - started > timeoutMs) throw new Error('poll timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const hasRow = (subject: string) => screen.queryByText(subject) !== null;

describe('token snippets', () => {
  it('points snippets at the daemon only under the Vite dev server', () => {
    const daemon = { host: '0.0.0.0', port: 9876 };
    expect(agentOrigin('http://127.0.0.1:19876', daemon, true)).toBe('http://127.0.0.1:9876');
    expect(agentOrigin('https://hive.example', daemon, false)).toBe('https://hive.example');
    expect(agentOrigin('http://127.0.0.1:19876', undefined, true)).toBe('http://127.0.0.1:19876');
  });

  it('builds an MCP config and a curl probe for the origin', () => {
    const config = JSON.parse(mcpConfigSnippet('https://hive.example/', 'bh_agent_x'));
    expect(config).toEqual({
      mcpServers: {
        browserhive: {
          type: 'http',
          url: 'https://hive.example/mcp',
          headers: { Authorization: 'Bearer bh_agent_x' },
        },
      },
    });
    const curl = curlSnippet('https://hive.example', 'bh_agent_x');
    expect(curl).toContain('https://hive.example/mcp');
    expect(curl).toContain("-H 'Authorization: Bearer bh_agent_x'");
    expect(curl).toContain('"method":"initialize"');
  });
});

describe('TokensSection', () => {
  it('lists tokens with prefix copy, last use and "never"', async () => {
    const view = mount();
    const table = await screen.findByRole('region', { name: 'API tokens' });
    const first = within(table).getByText('agent-1').closest('tr');
    const second = within(table).getByText('agent-2').closest('tr');
    if (first === null || second === null) throw new Error('rows missing');
    expect(within(first).getByText('pfx1abcd')).toBeTruthy();
    expect(within(first).getByRole('button', { name: 'Copy prefix pfx1abcd' })).toBeTruthy();
    expect(within(first).getByText('1m ago', { exact: false })).toBeTruthy();
    expect(within(second).getAllByText('never')).toHaveLength(2);
    expect(within(second).getByText('mcp:tools')).toBeTruthy();
    expect(view.container.textContent).not.toContain('bh_agent_');
    await expectNoA11yViolations(view.container);
  });

  it('explains bearer auth when there are no tokens', async () => {
    const view = mount({ rows: [] });
    await screen.findByText(/No agent tokens yet/);
    const text = view.container.textContent ?? '';
    expect(text).toContain('Authorization: Bearer <token>');
    expect(text).toContain('/mcp');
    expect(text).toContain('MCP clients guide');
    expect(screen.getByRole('button', { name: 'Create token' })).toBeTruthy();
    await expectNoA11yViolations(view.container);
  });

  it('shows the plaintext once with snippets and purges it on close', async () => {
    const view = mount();
    await screen.findByRole('region', { name: 'API tokens' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
    });
    await screen.findByText('Enter a name of 1 to 80 characters, e.g. ci-runner.');
    expect(view.requests.some((r) => r.method === 'POST')).toBe(false);

    await act(async () => {
      fireEvent.input(screen.getByLabelText('Agent name'), { target: { value: 'ci-runner' } });
      fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
    });
    const dialog = await screen.findByRole('dialog', { name: 'Token created' });
    expect(view.requests.find((r) => r.method === 'POST')?.body).toEqual({
      owner_kind: 'agent',
      display: 'ci-runner',
    });
    expect(within(dialog).getByTestId('token-plaintext').textContent).toBe(PLAINTEXT);
    expect(within(dialog).getByText('This is the only time the token is shown')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Copy token' })).toBeTruthy();
    const snippets = dialog.textContent ?? '';
    const origin = window.location.origin;
    expect(snippets).toContain(`"url": "${origin}/mcp"`);
    expect(snippets).toContain(`"Authorization": "Bearer ${PLAINTEXT}"`);
    expect(snippets).toContain(`curl -i ${origin}/mcp`);
    await expectNoA11yViolations(dialog, { disable: ['aria-hidden-focus'] });

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'I have copied the token' }));
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.body.textContent).not.toContain(PLAINTEXT);
    const cached = JSON.stringify([
      view.client
        .getQueryCache()
        .getAll()
        .map((q) => q.state.data),
      view.client
        .getMutationCache()
        .getAll()
        .map((m) => m.state.data),
    ]);
    expect(cached).not.toContain(PLAINTEXT);
    expect(window.location.href).not.toContain(PLAINTEXT);
    await screen.findByText('ci-runner');
    expect((screen.getByLabelText('Agent name') as HTMLInputElement).value).toBe('');
  });

  it('revokes after a confirm naming principal and prefix, removing the row at once', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const view = mount({ gate });
    await screen.findByRole('region', { name: 'API tokens' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Revoke token pfx1abcd for agent-1' }));
    });
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm.textContent).toContain('agent-1');
    expect(confirm.textContent).toContain('pfx1abcd');
    await act(async () => {
      fireEvent.click(within(confirm).getByRole('button', { name: 'Revoke' }));
    });
    await poll(() => !hasRow('agent-1'));
    expect(hasRow('agent-2')).toBe(true);
    release();
    await poll(() => view.requests.filter((r) => r.path === '/api/v1/auth/tokens').length >= 2);
    expect(view.requests.some((r) => r.method === 'DELETE')).toBe(true);
    expect(hasRow('agent-1')).toBe(false);
  });

  it('rolls the row back and toasts the code when revoke fails', async () => {
    mount({ failRevoke: true });
    await screen.findByRole('region', { name: 'API tokens' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Revoke token pfx1abcd for agent-1' }));
    });
    const confirm = await screen.findByRole('alertdialog');
    await act(async () => {
      fireEvent.click(within(confirm).getByRole('button', { name: 'Revoke' }));
    });
    await poll(() => screen.queryAllByText('INTERNAL_ERROR').length > 0);
    await poll(() => hasRow('agent-1'));
    expect(screen.getAllByText('Could not revoke token').length).toBeGreaterThan(0);
  });

  it('renders a disabled explanation when the principal is forbidden', async () => {
    const view = mount({ list: problem(403, 'FORBIDDEN', 'Forbidden') });
    await screen.findByText('Token management needs an operator');
    expect(screen.queryByRole('button', { name: 'Create token' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'API tokens' })).toBeNull();
    expect(screen.queryByText('Try again')).toBeNull();
    await expectNoA11yViolations(view.container);
  });
});

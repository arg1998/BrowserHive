/** @module features/templates/detail/Relogin.test — a re-login in progress on the template page (spec 13 §8.4, PR T2): queued until Show window, the open window with I'm signed in and its deadline, the agents-paused banner with the confirmed Let agents continue, signed in again with Remove sign-in for other sites, a failure's words, live progress from `template.relogin`, and the vault card (not enabled; problems; Allow this template confirmed; 403 explained); axe on each */
import { describe, expect, it } from 'bun:test';
import { bindingRow } from '@/features/vault/fixtures.ts';
import {
  hostView,
  reloginView,
  signedInSite,
  signedOutSite,
  templateDetail,
  tid,
} from '../../../../test/fixtures/templates.ts';
import { expectNoA11yViolations } from '../../../../test/helpers/axe.ts';
import { envelope, problem, renderPage } from '../../../../test/helpers/page-harness.tsx';
import { act, fireEvent, screen, waitFor, within } from '../../../../test/helpers/render.tsx';
import { pickOption } from '../../../../test/helpers/select.ts';
import { templatePageSearch } from '../search.ts';
import { TemplatePage } from './TemplatePage.tsx';

const ID = tid(1);
const AXE = { disable: ['aria-hidden-focus'] } as const;
const SITES = [signedInSite('linkedin.com'), signedOutSite('indeed.com')];

function mount(routes: Record<string, unknown>, vault = false) {
  return renderPage({
    path: '/templates/$id',
    component: TemplatePage,
    validateSearch: (s) => templatePageSearch.parse(s),
    routes: {
      'GET /system': { vault: { enabled: vault, backend: vault ? 'bitwarden' : null } },
      'GET /sessions': { data: [], page: { next_cursor: null, limit: 100 } },
      ...routes,
    },
    url: `/templates/${ID}`,
  });
}

function detailWith(relogin: ReturnType<typeof reloginView> | null, paused = false) {
  const base = templateDetail({ sites: SITES });
  return { ...base, relogin, host: { ...base.host, agents_paused: paused } };
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
  });
}

describe('re-login progress', () => {
  it('a queued re-login waits for Show window (header and card); axe clean', async () => {
    const view = mount({
      [`GET /templates/${ID}`]: detailWith(
        reloginView({
          state: 'queued',
          session_id: null,
          deadline_at: null,
          requested_by: 'telegram:42',
          agents_paused: false,
        }),
      ),
      [`POST /templates/${ID}/host/show`]: { ok: true, window: 'relogin', session_id: 'ses_x' },
    });
    const progress = await screen.findByRole('region', { name: 'Re-login of indeed.com' });
    expect(within(progress).getByText('Waiting for you')).toBeDefined();
    expect(within(progress).getByText(/Asked for from Telegram \(user 42\)/)).toBeDefined();
    expect(within(progress).queryByRole('button', { name: /I’m signed in/ })).toBeNull();
    expect(screen.getAllByRole('button', { name: /Show window/ })).toHaveLength(2);
    await expectNoA11yViolations(view.container, AXE);
    await click(screen.getAllByRole('button', { name: /Show window/ })[0] as HTMLElement);
    await waitFor(() =>
      expect(view.requests.some((r) => r.path.endsWith('/host/show'))).toBe(true),
    );
  });

  it('an open window: I’m signed in, its deadline, and the paused banner with a confirmed override', async () => {
    const view = mount({
      [`GET /templates/${ID}`]: detailWith(reloginView(), true),
      [`POST /templates/${ID}/relogin/confirm`]: {
        session_id: null,
        relogin: reloginView({ state: 'signed_in', version: 7 }),
      },
      [`POST /templates/${ID}/agents/continue`]: { ok: true, agents_paused: false },
    });
    expect(
      await screen.findByText('Agents are paused while you sign in to indeed.com'),
    ).toBeDefined();
    const progress = screen.getByRole('region', { name: 'Re-login of indeed.com' });
    expect(within(progress).getByText(/The window closes by itself/)).toBeDefined();
    await expectNoA11yViolations(view.container, AXE);
    await click(screen.getByRole('button', { name: /Let agents continue/ }));
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText(/Agents may change cookies while you sign in/)).toBeDefined();
    await click(within(confirm).getByRole('button', { name: 'Let agents continue' }));
    await waitFor(() =>
      expect(view.requests.some((r) => r.path.endsWith('/agents/continue'))).toBe(true),
    );
    await click(within(progress).getByRole('button', { name: 'I’m signed in: indeed.com' }));
    await waitFor(() => {
      const confirmCall = view.requests.find((r) => r.path.endsWith('/relogin/confirm'));
      expect(confirmCall?.body).toEqual({ site_id: 'indeed.com' });
    });
  });

  it('signed in again lists other sites’ sign-ins with Remove sign-in', async () => {
    const view = mount({
      [`GET /templates/${ID}`]: detailWith(
        reloginView({
          state: 'signed_in',
          version: 7,
          finished_at: 1_700_000_000_000,
          agents_paused: false,
          unlisted_domains: ['google.com'],
        }),
      ),
      [`POST /templates/${ID}/domains/google.com/remove-sign-in`]: { ok: true, removed_cookies: 3 },
    });
    const progress = await screen.findByRole('region', { name: 'Re-login of indeed.com' });
    expect(within(progress).getByText(/saved as version 7/)).toBeDefined();
    await click(within(progress).getByRole('button', { name: 'Remove sign-in to google.com' }));
    await waitFor(() =>
      expect(view.requests.some((r) => r.path.endsWith('/google.com/remove-sign-in'))).toBe(true),
    );
  });

  it('a failure says why and offers Try again', async () => {
    mount({
      [`GET /templates/${ID}`]: detailWith(
        reloginView({
          state: 'failed',
          method: 'vault',
          error: 'retry_window',
          agents_paused: false,
          finished_at: 1,
        }),
      ),
    });
    const progress = await screen.findByRole('region', { name: 'Re-login of indeed.com' });
    expect(within(progress).getByText(/does not retry it automatically/)).toBeDefined();
    await click(within(progress).getByRole('button', { name: /Try again/ }));
    expect(await screen.findByRole('dialog', { name: 'Re-login to indeed.com' })).toBeDefined();
  });

  it('follows template.relogin and template.host live', async () => {
    const view = mount({ [`GET /templates/${ID}`]: detailWith(null) });
    await screen.findByRole('heading', { level: 2, name: 'indeed.com' });
    expect(screen.queryByRole('region', { name: 'Re-login of indeed.com' })).toBeNull();
    view.connect();
    view.emit('templates', { type: 'template.relogin', template_id: ID, relogin: reloginView() });
    expect(await screen.findByText('Window open')).toBeDefined();
    expect(await screen.findByText(/Agents are paused/)).toBeDefined();
    view.emit('templates', {
      type: 'template.host',
      template_id: ID,
      host: hostView({ state: 'running', agents_paused: false }),
    });
    // The query cache notifies on a timer: let it flush.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.queryByText(/Agents are paused/)).toBeNull();
  });
});

describe('automatic re-login (vault)', () => {
  it('says Not enabled without a vault', async () => {
    mount({ [`GET /templates/${ID}`]: detailWith(null) });
    expect((await screen.findAllByText(/Not enabled: it needs the vault/)).length).toBe(2);
  });

  it('explains a binding’s problems and Allow this template asks first; axe clean', async () => {
    const view = mount(
      {
        [`GET /templates/${ID}`]: detailWith(null),
        'GET /vault/bindings': envelope([
          bindingRow({ handle: 'indeed', title: 'Indeed', authorized_principals: ['operator'] }),
        ]),
        [`PUT /templates/${ID}/sites/indeed.com/relogin`]: {
          site: signedOutSite('indeed.com', { vault_handle: 'indeed' }),
          binding_allows_template: true,
          binding_problems: [],
        },
      },
      true,
    );
    await click(
      await screen.findByRole('button', { name: 'Set up automatic re-login: indeed.com' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Automatic re-login for indeed.com' });
    expect(within(dialog).getByRole('switch').getAttribute('aria-disabled')).toBe('true');
    await expectNoA11yViolations(dialog, AXE);
    // Pick the binding: `template:<id>` not listed is the problem; session names are not (M-1).
    await pickOption(within(dialog).getByRole('combobox'), /Indeed · indeed/);
    expect(await within(dialog).findByText(/doesn’t list this template yet/)).toBeDefined();
    expect(within(dialog).queryByText(/session names/)).toBeNull();
    fireEvent.change(within(dialog).getByLabelText('Username field'), {
      target: { value: '#email' },
    });
    fireEvent.change(within(dialog).getByLabelText('Password field'), {
      target: { value: '#pass' },
    });
    fireEvent.change(within(dialog).getByLabelText(/Sign-in page path/), {
      target: { value: '/login' },
    });
    await click(within(dialog).getByRole('button', { name: /Allow this template/ }));
    const confirm = await screen.findByRole('alertdialog');
    expect(
      within(confirm).getByText(
        `Adds template:${ID} to this credential’s principals. BrowserHive then fills it only into this template’s own sign-in sessions; it can’t be used by agents’ sessions. Remove the principal on the Vault page to take it back.`,
      ),
    ).toBeDefined();
    await click(within(confirm).getByRole('button', { name: 'Allow this template' }));
    await waitFor(() => {
      const put = view.requests.find((r) => r.method === 'PUT');
      expect(put?.body).toEqual({
        vault_handle: 'indeed',
        auto_relogin: false,
        form: { username: '#email', password: '#pass', path: '/login' },
        allow_template: true,
      });
    });
  });

  it('a binding open to every principal is explained, without Allow; a 403 is explained', async () => {
    mount(
      {
        [`GET /templates/${ID}`]: detailWith(null),
        'GET /vault/bindings': envelope([
          bindingRow({ handle: 'indeed', title: 'Indeed', allow_all_sessions: true }),
        ]),
        [`PUT /templates/${ID}/sites/indeed.com/relogin`]: problem(403, 'FORBIDDEN'),
      },
      true,
    );
    await click(
      await screen.findByRole('button', { name: 'Set up automatic re-login: indeed.com' }),
    );
    const dialog = await screen.findByRole('dialog');
    await pickOption(within(dialog).getByRole('combobox'), /Indeed · indeed/);
    expect(await within(dialog).findByText(/lets every principal use it/)).toBeDefined();
    expect(within(dialog).queryByRole('button', { name: /Allow this template/ })).toBeNull();
    fireEvent.change(within(dialog).getByLabelText('Username field'), { target: { value: '#e' } });
    fireEvent.change(within(dialog).getByLabelText('Password field'), { target: { value: '#p' } });
    await click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(
      await within(dialog).findByText(/needs both templates:login and vault:write/),
    ).toBeDefined();
  });
});

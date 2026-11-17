/** @module features/templates/detail/SitesTab.test — the Sites tab of spec 13 §8 (PR T2): health with its reason and last check, Check now (one site and all, sharing one pending state; a signed-out finding warns), the couldn't-tell warning after three inconclusive checks, live health over the `templates` topic, Re-login… from a card and the header menu (window by default, vault when linked, agents paused unless let continue), and a refused start explained; axe on each state */
import { describe, expect, it } from 'bun:test';
import {
  signedInSite,
  signedOutSite,
  TT0,
  templateDetail,
  templateSite,
  tid,
} from '../../../../test/fixtures/templates.ts';
import { expectNoA11yViolations } from '../../../../test/helpers/axe.ts';
import { problem, renderPage } from '../../../../test/helpers/page-harness.tsx';
import { act, fireEvent, screen, waitFor, within } from '../../../../test/helpers/render.tsx';
import { templatePageSearch } from '../search.ts';
import { TemplatePage } from './TemplatePage.tsx';

const ID = tid(1);
const AXE = { disable: ['aria-hidden-focus'] } as const;

function mount(routes: Record<string, unknown>, url = `/templates/${ID}`) {
  return renderPage({
    path: '/templates/$id',
    component: TemplatePage,
    validateSearch: (s) => templatePageSearch.parse(s),
    routes: {
      'GET /system': { vault: { enabled: false, backend: null } },
      'GET /sessions': { data: [], page: { next_cursor: null, limit: 100 } },
      ...routes,
    },
    url,
  });
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
  });
}

describe('Sites tab: health', () => {
  it('shows each site’s reason and last check, and Check now probes that site; axe clean', async () => {
    const view = mount({
      [`GET /templates/${ID}`]: templateDetail({
        sites: [signedInSite('linkedin.com'), signedOutSite('indeed.com')],
      }),
      [`POST /templates/${ID}/probe`]: {
        results: [
          {
            site_id: 'indeed.com',
            outcome: 'signed_in',
            reason: 'learned_cookies',
            duration_ms: 9,
          },
        ],
      },
    });
    const card = (await screen.findByRole('heading', { level: 2, name: 'indeed.com' })).closest(
      'section',
    ) as HTMLElement;
    expect(within(card).getByText('Its sign-in cookies are gone.')).toBeDefined();
    expect(within(card).getByText(/Last checked/)).toBeDefined();
    await expectNoA11yViolations(view.container, AXE);
    await click(within(card).getByRole('button', { name: 'Check now: indeed.com' }));
    await waitFor(() => {
      const probe = view.requests.find((r) => r.path.endsWith('/probe'));
      expect(probe?.body).toEqual({ site_ids: ['indeed.com'] });
    });
    expect((await screen.findAllByText('indeed.com: signed in')).length).toBeGreaterThan(0);
  });

  it('Check all now probes every site', async () => {
    const view = mount({
      [`GET /templates/${ID}`]: templateDetail(),
      [`POST /templates/${ID}/probe`]: {
        results: [
          {
            site_id: 'linkedin.com',
            outcome: 'signed_in',
            reason: 'learned_cookies',
            duration_ms: 9,
          },
          {
            site_id: 'indeed.com',
            outcome: 'signed_out',
            reason: 'cookies_absent',
            duration_ms: 9,
          },
        ],
      },
    });
    expect(await screen.findByText(/checks each site every 6 hours/)).toBeDefined();
    await click(screen.getByRole('button', { name: 'Check all now' }));
    await waitFor(() => {
      const probe = view.requests.find((r) => r.path.endsWith('/probe'));
      expect(probe?.body).toEqual({});
    });
    expect((await screen.findAllByText('Checked 2 sites: 1 not signed in')).length).toBeGreaterThan(
      0,
    );
  });

  it('Check now and Check all now share one pending state (L-16); axe clean while checking', async () => {
    let release: (value: unknown) => void = () => undefined;
    const view = mount({
      [`GET /templates/${ID}`]: templateDetail(),
      [`POST /templates/${ID}/probe`]: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    const indeed = (await screen.findByRole('heading', { level: 2, name: 'indeed.com' })).closest(
      'section',
    ) as HTMLElement;
    const linkedin = screen
      .getByRole('heading', { level: 2, name: 'linkedin.com' })
      .closest('section') as HTMLElement;
    await click(within(indeed).getByRole('button', { name: 'Check now: indeed.com' }));
    const all = await screen.findByRole('button', { name: /Checking…/ });
    expect(all.hasAttribute('disabled')).toBe(true);
    for (const card of [indeed, linkedin]) {
      const button = within(card).getByRole('button', { name: /^Check now:/ });
      expect(button.hasAttribute('disabled')).toBe(true);
      expect(button.textContent).toContain('Checking…');
    }
    // Only the site being checked says so in its sign-in line.
    expect(within(indeed).getByText('Checking…', { selector: 'span' })).toBeDefined();
    expect(within(linkedin).queryByText('Checking…', { selector: 'span' })).toBeNull();
    await expectNoA11yViolations(view.container, AXE);
    await act(async () => {
      release({
        results: [
          {
            site_id: 'indeed.com',
            outcome: 'signed_out',
            reason: 'cookies_absent',
            duration_ms: 9,
          },
        ],
      });
    });
    // A check that finds the site signed out is a warning, not a success (L-18).
    const title = (await screen.findAllByText('indeed.com: signed out'))
      .map((el) => el.closest('[data-slot="toast"]'))
      .find((el) => el !== null);
    expect(title?.querySelector('.lucide-triangle-alert')).not.toBeNull();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Check all now' }).hasAttribute('disabled')).toBe(
        false,
      ),
    );
  });

  it('warns after three checks in a row that couldn’t tell', async () => {
    mount({
      [`GET /templates/${ID}`]: templateDetail({
        sites: [
          signedInSite('linkedin.com'),
          templateSite('indeed.com', {
            health: {
              state: 'inconclusive',
              checked_at: TT0 - 1000,
              changed_at: TT0 - 1000,
              reason: 'partial_cookies',
              consecutive_inconclusive: 3,
            },
          }),
        ],
      }),
    });
    expect(
      await screen.findByText(/BrowserHive couldn’t tell whether indeed.com is signed in/),
    ).toBeDefined();
    expect(screen.getByText('Only some of its sign-in cookies are there.')).toBeDefined();
  });

  it('a check that couldn’t tell reads “Couldn’t tell” with its reason and Check now, never signed out', async () => {
    const view = mount({
      [`GET /templates/${ID}`]: templateDetail({
        sites: [
          signedInSite('indeed.com'),
          templateSite('linkedin.com', {
            health: {
              state: 'inconclusive',
              checked_at: TT0 - 1000,
              changed_at: TT0 - 1000,
              reason: 'no_signal',
              consecutive_inconclusive: 1,
            },
          }),
        ],
      }),
      [`POST /templates/${ID}/probe`]: {
        results: [
          {
            site_id: 'indeed.com',
            outcome: 'signed_in',
            reason: 'learned_cookies',
            duration_ms: 9,
          },
          { site_id: 'linkedin.com', outcome: 'inconclusive', reason: 'no_signal', duration_ms: 9 },
        ],
      },
    });
    const card = (await screen.findByRole('heading', { level: 2, name: 'linkedin.com' })).closest(
      'section, article, li',
    ) as HTMLElement;
    expect(within(card).getAllByText(/^Couldn.t tell$/).length).toBeGreaterThan(0);
    expect(within(card).getByText('Nothing showed whether you are signed in.')).toBeDefined();
    expect(within(card).queryByText(/Signed out|Not signed in/)).toBeNull();
    expect(screen.queryByText(/isn’t signed in/)).toBeNull();
    expect(within(card).getByRole('button', { name: 'Check now: linkedin.com' })).toBeDefined();
    await expectNoA11yViolations(view.container, AXE);
    await click(screen.getByRole('button', { name: 'Check all now' }));
    expect((await screen.findAllByText('Checked 2 sites: 1 couldn’t tell')).length).toBeGreaterThan(
      0,
    );
    expect(screen.queryByText(/not signed in/)).toBeNull();
  });

  it('says why a check couldn’t run (browser not running)', async () => {
    mount({
      [`GET /templates/${ID}`]: templateDetail({
        sites: [
          templateSite('linkedin.com', {
            health: {
              state: 'inconclusive',
              checked_at: TT0,
              changed_at: TT0,
              reason: 'not_running',
              consecutive_inconclusive: 1,
            },
          }),
        ],
      }),
    });
    expect(await screen.findByText('Couldn’t check: the browser isn’t running.')).toBeDefined();
  });

  it('updates a card live from template.health', async () => {
    const view = mount({ [`GET /templates/${ID}`]: templateDetail() });
    await screen.findByRole('heading', { level: 2, name: 'indeed.com' });
    view.connect();
    view.emit('templates', {
      type: 'template.health',
      template_id: ID,
      site: signedOutSite('indeed.com'),
    });
    expect(await screen.findByText('Its sign-in cookies are gone.')).toBeDefined();
    expect(await screen.findByText('1 site isn’t signed in')).toBeDefined();
  });
});

describe('Sites tab: Re-login…', () => {
  it('opens a window from a card: agents paused by default; axe clean on the dialog', async () => {
    const view = mount({
      [`GET /templates/${ID}`]: templateDetail({
        sites: [signedInSite('linkedin.com'), signedOutSite('indeed.com')],
      }),
      [`POST /templates/${ID}/relogin`]: {
        session_id: 'ses_relogin0001',
        relogin: { ...templateDetail().relogin, site_id: 'indeed.com' },
      },
    });
    await click(await screen.findByRole('button', { name: 'Re-login: indeed.com' }));
    const dialog = await screen.findByRole('dialog', { name: 'Re-login to indeed.com' });
    expect(within(dialog).getByText('hive-box')).toBeDefined();
    expect(within(dialog).queryByText('With the vault')).toBeNull();
    await expectNoA11yViolations(dialog, AXE);
    await click(within(dialog).getByRole('button', { name: 'Open sign-in window' }));
    await waitFor(() => {
      const start = view.requests.find((r) => r.method === 'POST' && r.path.endsWith('/relogin'));
      expect(start?.body).toEqual({
        site_id: 'indeed.com',
        method: 'window',
        let_agents_continue: false,
      });
    });
  });

  it('offers the vault when a binding is linked and can let agents continue for a window', async () => {
    const view = mount({
      [`GET /templates/${ID}`]: templateDetail({
        sites: [
          signedInSite('linkedin.com'),
          signedOutSite('indeed.com', { vault_handle: 'indeed' }),
        ],
      }),
      [`POST /templates/${ID}/relogin`]: {
        status: 409,
        body: {
          ...problem(409, 'CONFLICT').body,
          detail: 'A re-login of linkedin.com is waiting for you; finish or cancel it first.',
        },
      },
    });
    const menu = await screen.findByRole('button', { name: /^Re-login$/ });
    await click(menu);
    await click(await screen.findByRole('menuitem', { name: /indeed.com/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Re-login to indeed.com' });
    expect(within(dialog).getByText('With the vault')).toBeDefined();
    await click(within(dialog).getByRole('checkbox', { name: /Let agents continue/ }));
    await click(within(dialog).getByRole('button', { name: 'Open sign-in window' }));
    // A 409 says what the server says is in the way (review #81 M-6), under the dialog's own title.
    expect(await within(dialog).findByText(/linkedin.com is waiting for you/)).toBeDefined();
    expect(within(dialog).getByText('The re-login didn’t start')).toBeDefined();
    const start = view.requests.find((r) => r.method === 'POST' && r.path.endsWith('/relogin'));
    expect(start?.body).toMatchObject({ method: 'window', let_agents_continue: true });
  });

  it('fills from the vault when chosen', async () => {
    const view = mount({
      [`GET /templates/${ID}`]: templateDetail({
        sites: [signedOutSite('indeed.com', { vault_handle: 'indeed' })],
      }),
      [`POST /templates/${ID}/relogin`]: {
        session_id: null,
        relogin: { ...templateDetail().relogin, site_id: 'indeed.com' },
      },
    });
    await click(await screen.findByRole('button', { name: 'Re-login: indeed.com' }));
    const dialog = await screen.findByRole('dialog');
    await click(within(dialog).getByRole('button', { name: 'With the vault' }));
    await click(within(dialog).getByRole('button', { name: 'Fill from the vault' }));
    await waitFor(() => {
      const start = view.requests.find((r) => r.method === 'POST' && r.path.endsWith('/relogin'));
      expect(start?.body).toMatchObject({ site_id: 'indeed.com', method: 'vault' });
    });
  });
});

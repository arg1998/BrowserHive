/** @module features/templates/detail/ReloginReview.test — the re-login fixes of review #81: signing in through the live view when the browser has no window to show (M-2: copy, the link, Show window going there, the dialog's answer), **Done** when the site's cookies were already there (M-5), a refusal titled by its own action with the server's reason (M-6), the paused banner's 15 s copy (L-5), focus and a toast when the panel or the banner goes (L-15), and no Re-login on the signed-out banner while one runs (L-17); axe on each */
import { describe, expect, it } from 'bun:test';
import {
  reloginView,
  signedInSite,
  signedOutSite,
  templateDetail,
  tid,
} from '../../../../test/fixtures/templates.ts';
import { expectNoA11yViolations } from '../../../../test/helpers/axe.ts';
import {
  problem,
  type RecordedRequest,
  renderPage,
} from '../../../../test/helpers/page-harness.tsx';
import { act, fireEvent, screen, waitFor, within } from '../../../../test/helpers/render.tsx';
import { templatePageSearch } from '../search.ts';
import { TemplatePage } from './TemplatePage.tsx';

const ID = tid(1);
const AXE = { disable: ['aria-hidden-focus'] } as const;
const SITES = [signedInSite('linkedin.com'), signedOutSite('indeed.com')];
const LIVE = '/sessions/ses_relogin0001?live=1&takeover=1';

function mount(routes: Record<string, unknown>) {
  return renderPage({
    path: '/templates/$id',
    component: TemplatePage,
    validateSearch: (s) => templatePageSearch.parse(s),
    routes: {
      'GET /system': { vault: { enabled: false, backend: null } },
      'GET /sessions': { data: [], page: { next_cursor: null, limit: 100 } },
      ...routes,
    },
    url: `/templates/${ID}`,
  });
}

function detailWith(
  relogin: ReturnType<typeof reloginView> | null,
  paused = false,
  patch: Parameters<typeof templateDetail>[0] = {},
) {
  const base = templateDetail({ sites: SITES, ...patch });
  return { ...base, relogin, host: { ...base.host, agents_paused: paused } };
}

/** A 409 whose problem names what is in the way. */
function conflict(detail: string) {
  return { status: 409, body: { ...problem(409, 'CONFLICT').body, detail } };
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
  });
}

/** The toast with this title (the stack also announces it, so the text appears twice). */
async function findToast(title: string): Promise<HTMLElement> {
  const toast = (await screen.findAllByText(title))
    .map((el) => el.closest<HTMLElement>('[data-slot="toast"]'))
    .find((el) => el !== null);
  if (toast === undefined || toast === null) throw new Error(`no toast "${title}"`);
  return toast;
}

describe('signing in through the live view (M-2)', () => {
  it('an open live-view re-login says so and links the live view, card and header; axe clean', async () => {
    const view = mount({
      [`GET /templates/${ID}`]: detailWith(
        reloginView({ sign_in_via: 'live_view', agents_paused: false }),
      ),
    });
    const progress = await screen.findByRole('region', { name: 'Re-login of indeed.com' });
    expect(
      within(progress).getByText(
        'This template’s browser has no window to show here: sign in through the live view. Agents wait only while you type.',
      ),
    ).toBeDefined();
    const links = screen.getAllByRole('link', { name: 'Sign in in the live view' });
    expect(links).toHaveLength(2);
    for (const link of links) expect(link.getAttribute('href')).toBe(LIVE);
    expect(screen.queryByRole('button', { name: /Show window/ })).toBeNull();
    await expectNoA11yViolations(view.container, AXE);
  });

  it('Show window on a queued re-login goes to the live view once it opened there', async () => {
    let opened = false;
    const view = mount({
      [`GET /templates/${ID}`]: () =>
        detailWith(
          opened
            ? reloginView({ sign_in_via: 'live_view', agents_paused: false })
            : reloginView({ state: 'queued', session_id: null, sign_in_via: null }),
        ),
      [`POST /templates/${ID}/host/show`]: () => {
        opened = true;
        return { ok: true, window: 'relogin', session_id: 'ses_relogin0001' };
      },
    });
    const progress = await screen.findByRole('region', { name: 'Re-login of indeed.com' });
    await click(within(progress).getByRole('button', { name: /Show window/ }));
    await waitFor(() => expect(view.router.state.location.href).toBe(LIVE));
  });

  it('the dialog of a running headless template says where to sign in, then links the live view', async () => {
    const view = mount({
      [`GET /templates/${ID}`]: detailWith(null, false, { headless: true }),
      [`POST /templates/${ID}/relogin`]: {
        session_id: 'ses_relogin0001',
        relogin: reloginView({ sign_in_via: 'live_view', agents_paused: false }),
      },
    });
    await click(await screen.findByRole('button', { name: 'Re-login: indeed.com' }));
    const dialog = await screen.findByRole('dialog', { name: 'Re-login to indeed.com' });
    expect(within(dialog).getByText(/sign in through the live view/)).toBeDefined();
    expect(within(dialog).queryByText(/A window opens at the site/)).toBeNull();
    await click(within(dialog).getByRole('button', { name: 'Start sign-in' }));
    const link = await within(dialog).findByRole('link', { name: 'Sign in in the live view' });
    expect(link.getAttribute('href')).toBe(LIVE);
    await expectNoA11yViolations(dialog, AXE);
    expect(view.requests.some((r) => r.method === 'POST' && r.path.endsWith('/relogin'))).toBe(
      true,
    );
  });
});

describe('Done when the cookies were already there (M-5)', () => {
  it('reads Done with why, and confirms; axe clean', async () => {
    const view = mount({
      [`GET /templates/${ID}`]: detailWith(
        reloginView({ confirm_required: true }),
        false,
        // A site with a pack is confirmed too when the cookies were already there.
      ),
      [`POST /templates/${ID}/relogin/confirm`]: {
        session_id: null,
        relogin: reloginView({ state: 'signed_in', version: 8 }),
      },
    });
    const progress = await screen.findByRole('region', { name: 'Re-login of indeed.com' });
    expect(
      within(progress).getByText(
        'This site’s sign-in cookies were already there, so BrowserHive can’t tell when you’re done. Sign in again if needed, then press Done.',
      ),
    ).toBeDefined();
    expect(within(progress).queryByRole('button', { name: /I’m signed in/ })).toBeNull();
    await expectNoA11yViolations(view.container, AXE);
    await click(within(progress).getByRole('button', { name: 'Done: indeed.com' }));
    await waitFor(() => {
      const call = view.requests.find((r) => r.path.endsWith('/relogin/confirm'));
      expect(call?.body).toEqual({
        site_id: 'indeed.com',
        requested_at: reloginView().requested_at,
      });
    });
  });
});

describe('refusals, focus and the banners', () => {
  it('a 409 of I’m signed in is titled by its action and says the server’s reason (M-6)', async () => {
    mount({
      [`GET /templates/${ID}`]: detailWith(reloginView()),
      [`POST /templates/${ID}/relogin/confirm`]: conflict(
        'No new cookies on indeed.com since the window opened; sign in there first.',
      ),
      [`DELETE /templates/${ID}/relogin`]: conflict('No re-login is queued or open.'),
    });
    const progress = await screen.findByRole('region', { name: 'Re-login of indeed.com' });
    await click(within(progress).getByRole('button', { name: 'I’m signed in: indeed.com' }));
    const refused = await findToast('The re-login isn’t finished');
    expect(within(refused).getByText(/No new cookies on indeed.com/)).toBeDefined();
    await click(within(progress).getByRole('button', { name: 'Cancel re-login' }));
    const notCancelled = await findToast('The re-login wasn’t cancelled');
    expect(within(notCancelled).getByText('No re-login is queued or open.')).toBeDefined();
    expect(screen.queryByText(/Another sign-in window is open/)).toBeNull();
  });

  it('Cancel re-login toasts and keeps focus on the site’s card (L-15)', async () => {
    let cancelled = false;
    mount({
      [`GET /templates/${ID}`]: () =>
        detailWith(reloginView(cancelled ? { state: 'cancelled', agents_paused: false } : {})),
      [`DELETE /templates/${ID}/relogin`]: (request: RecordedRequest) => {
        // Only the re-login this tab shows (review #81 L-2).
        expect(request.query.get('requested_at')).toBe(String(reloginView().requested_at));
        cancelled = true;
        return { session_id: null, relogin: reloginView({ state: 'cancelled' }) };
      },
    });
    const progress = await screen.findByRole('region', { name: 'Re-login of indeed.com' });
    const cancel = within(progress).getByRole('button', { name: 'Cancel re-login' });
    cancel.focus();
    await click(cancel);
    const toast = await findToast('Re-login of indeed.com cancelled');
    // Neutral, not a success: the info icon.
    expect(toast.querySelector('.lucide-info')).not.toBeNull();
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Re-login of indeed.com' })).toBeNull(),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('heading', { level: 2, name: 'indeed.com' }),
      ),
    );
  });

  it('the paused banner says 15 s; after Let agents continue focus goes to the site’s card (L-5, L-15)', async () => {
    let paused = true;
    mount({
      [`GET /templates/${ID}`]: () => detailWith(reloginView({ agents_paused: paused }), paused),
      [`POST /templates/${ID}/agents/continue`]: () => {
        paused = false;
        return { ok: true, agents_paused: false };
      },
    });
    expect(
      await screen.findByText(
        'Launches and tool calls of this template’s sessions wait up to 15 s each, then get a retryable error, until the sign-in window closes.',
      ),
    ).toBeDefined();
    const button = screen.getByRole('button', { name: /Let agents continue/ });
    button.focus();
    await click(button);
    const confirm = await screen.findByRole('alertdialog');
    await click(within(confirm).getByRole('button', { name: 'Let agents continue' }));
    await waitFor(() => expect(screen.queryByText(/Agents are paused/)).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('heading', { level: 2, name: 'indeed.com' }),
      ),
    );
  });

  it('the signed-out banner offers no Re-login while one runs (L-17); axe clean', async () => {
    const view = mount({
      [`GET /templates/${ID}`]: detailWith(
        reloginView({ state: 'queued', session_id: null, sign_in_via: null, agents_paused: false }),
      ),
    });
    const banner = (await screen.findByText('1 site isn’t signed in')).closest(
      '[data-slot="callout"], [role="note"], div',
    ) as HTMLElement;
    expect(screen.getByText(/A re-login of indeed.com is under way/)).toBeDefined();
    expect(within(banner).queryByRole('button', { name: /Re-login…/ })).toBeNull();
    await expectNoA11yViolations(view.container, AXE);
  });
});

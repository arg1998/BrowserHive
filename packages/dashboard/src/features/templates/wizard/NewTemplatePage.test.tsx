/** @module features/templates/wizard/NewTemplatePage.test — the new-template wizard over fake routes: steps in the URL with focus on the step heading, the name suggested from the display name, `POST /templates` with the draft, a taken name sent back to step 1, then the sign-in step: open the window, I'm signed in, Finish with an unlisted sign-in removed, the ready screen; a refused start shows its error state; the remote-operator notice; Cancel on every step (asking first when there is a draft) and Cancel setup on the sign-in step (deletes the template); the draft lives in this tab's `sessionStorage` only (an old `localStorage` copy is dropped) and never moves the operator past step 1; axe on every step */
import { beforeEach, describe, expect, it } from 'bun:test';
import type { Template } from '@browserhive/contracts/http';
import { createRoute } from '@tanstack/react-router';
import { systemInfo } from '../../../../test/fixtures/ops.ts';
import { sessionSummary, sessionsPage } from '../../../../test/fixtures/sessions.ts';
import {
  signedInSite,
  template,
  templateDetail,
  templateSite,
  tid,
} from '../../../../test/fixtures/templates.ts';
import { expectNoA11yViolations } from '../../../../test/helpers/axe.ts';
import {
  type FakeRoute,
  problem,
  type RecordedRequest,
  renderPage,
} from '../../../../test/helpers/page-harness.tsx';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '../../../../test/helpers/render.tsx';
import { RemoteOperatorBanner } from '../RemoteOperatorBanner.tsx';
import { wizardSearch } from '../search.ts';
import { CREATED_KEY, DRAFT_KEY } from './draft.ts';
import { NewTemplatePage } from './NewTemplatePage.tsx';
import { STEP_LABEL } from './StepRail.tsx';

const ID = tid(7);

/** A fake server holding one template as the wizard creates and records it. */
function server(
  options: {
    readonly startError?: { status: number; code: string };
    /** Start with the template already created (the sign-in step opened directly). */
    readonly existing?: boolean;
  } = {},
) {
  let created: Template | null =
    options.existing === true
      ? template(7, {
          template_id: ID,
          status: 'recording',
          sites: [templateSite('linkedin.com'), templateSite('indeed.com')],
        })
      : null;
  let windowOpen = false;
  let deleted = false;
  const recording = sessionSummary(9, {
    slug: 'recording',
    template: { template_id: ID, name: 'job-hunt', version: null, mode: 'maintenance' },
  });
  const detail = () =>
    templateDetail(created ?? {}, {
      host: { ...templateDetail().host, state: windowOpen ? 'running' : 'stopped' },
      sessions_live: 0,
      unlisted_domains: windowOpen ? ['google.com'] : [],
    });
  return {
    routes: {
      'GET /system': systemInfo({ auth_mode: 'off' }),
      'GET /notifications/report-settings': { host_time_zone: 'America/Toronto' },
      'POST /templates': (req: RecordedRequest) => {
        const body = req.body as { name: string; sites: { site_id: string }[] };
        if (body.name === 'taken') return problem(409, 'TEMPLATE_NAME_TAKEN');
        created = template(7, {
          template_id: ID,
          name: body.name,
          display_name: 'Job hunt',
          status: 'recording',
          sites: body.sites.map((s) => templateSite(s.site_id)),
        });
        return { status: 201, body: { template: created } };
      },
      [`GET /templates/${ID}`]: () => (deleted ? problem(404, 'TEMPLATE_NOT_FOUND') : detail()),
      [`DELETE /templates/${ID}`]: () => {
        deleted = true;
        windowOpen = false;
        return { ok: true, closed_sessions: [], deleted_bytes: 0 };
      },
      'GET /sessions': () => sessionsPage(windowOpen ? [recording] : []),
      [`POST /templates/${ID}/recording`]: () => {
        if (options.startError !== undefined)
          return problem(options.startError.status, options.startError.code);
        windowOpen = true;
        return { session_id: recording.session_id, host: detail().host };
      },
      [`POST /templates/${ID}/recording/confirm`]: (req: RecordedRequest) => {
        const site = (req.body as { site_id: string }).site_id;
        if (created !== null)
          created = {
            ...created,
            sites: created.sites.map((s) => (s.site_id === site ? signedInSite(site) : s)),
          };
        return { site: signedInSite(site) };
      },
      [`POST /templates/${ID}/recording/finish`]: () => {
        windowOpen = false;
        if (created !== null) created = { ...created, status: 'ready' };
        return { template: created, version: null, removed_sign_ins: [] };
      },
    },
  };
}

function mount(url: string, fake: { readonly routes: Record<string, FakeRoute> } = server()) {
  return renderPage({
    path: '/templates/new',
    component: NewTemplatePage,
    validateSearch: (s) => wizardSearch.parse(s),
    routes: fake.routes,
    url,
    extra: (root) => [
      createRoute({
        getParentRoute: () => root,
        path: '/templates',
        component: () => <p>Templates list</p>,
        staticData: { title: 'Templates' },
      }),
    ],
  });
}

/** A draft that passes steps 1–4. */
const FULL_DRAFT = { name: 'job-hunt', sites: ['linkedin.com'], access: 'all' };

/** Let the page's remaining queries (system, host time zone) answer inside `act`. */
const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
};

const click = async (element: HTMLElement) => {
  await act(async () => {
    fireEvent.click(element);
  });
};

beforeEach(() => {
  sessionStorage.removeItem(DRAFT_KEY);
  sessionStorage.removeItem(CREATED_KEY);
  localStorage.removeItem(DRAFT_KEY);
});

describe('NewTemplatePage', () => {
  it('walks the four steps with the step in the URL and creates the template; axe on each', async () => {
    const view = mount('/templates/new');
    const heading = await screen.findByRole('heading', { level: 2, name: 'Name' });
    fireEvent.change(screen.getByLabelText(/Display name/), { target: { value: 'Job hunt' } });
    expect((screen.getByLabelText(/Name for agents/) as HTMLInputElement).value).toBe('job-hunt');
    await expectNoA11yViolations(view.container);
    await click(screen.getByRole('button', { name: /Next/ }));
    await waitFor(() => expect(view.router.state.location.search).toMatchObject({ step: 2 }));
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Sites'));
    expect(heading.isConnected).toBe(true);

    // Step 2: Next without a site says so; then a full address is reduced to its domain.
    await click(screen.getByRole('button', { name: /Next/ }));
    expect(screen.getByText('Add at least one site.')).toBeDefined();
    fireEvent.change(screen.getByLabelText('Add a site'), {
      target: { value: 'https://www.linkedin.com/jobs' },
    });
    await click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('button', { name: 'Remove linkedin.com' })).toBeDefined();
    await expectNoA11yViolations(view.container);
    await click(screen.getByRole('button', { name: /Next/ }));

    // Steps 3 and 4 open with Next focused.
    await screen.findByRole('heading', { level: 2, name: 'Identity and network' });
    await waitFor(() => expect(document.activeElement?.textContent).toContain('Next'));
    expect(screen.getByRole('button', { name: 'Skip to sign-in' })).toBeDefined();
    await expectNoA11yViolations(view.container);
    await click(screen.getByRole('button', { name: /Next/ }));
    await screen.findByRole('heading', { level: 2, name: 'Access' });
    await expectNoA11yViolations(view.container);
    await click(screen.getByRole('button', { name: 'Create and sign in' }));

    await waitFor(() =>
      expect(view.router.state.location.search).toMatchObject({ step: 5, template: ID }),
    );
    const post = view.requests.find((r) => r.method === 'POST' && r.path === '/api/v1/templates');
    expect(post?.body).toEqual({
      name: 'job-hunt',
      display_name: 'Job hunt',
      sites: [{ site_id: 'linkedin.com' }],
      policy: { max_concurrent: 5 },
    });
    expect(sessionStorage.getItem(DRAFT_KEY)).toBeNull();
  }, 20_000);

  it('sends a taken name back to step 1', async () => {
    sessionStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({ name: 'taken', sites: ['linkedin.com'], access: 'all' }),
    );
    const view = mount('/templates/new?step=4');
    await click(await screen.findByRole('button', { name: 'Create and sign in' }));
    await waitFor(() => expect(view.router.state.location.search).toMatchObject({ step: 1 }));
    expect(await screen.findByText('A template is already called taken.')).toBeDefined();
  });

  it('opens the window, confirms a site, finishes with the unlisted sign-in removed; axe clean', async () => {
    const view = mount(`/templates/new?step=5&template=${ID}`, server({ existing: true }));
    const open = await screen.findByRole('button', { name: 'Open the sign-in window' });
    await expectNoA11yViolations(view.container);
    await click(open);
    await screen.findByText(
      /The sign-in window is open on the machine running BrowserHive/,
      undefined,
      {
        timeout: 3000,
      },
    );
    const confirm = screen.getByRole('button', { name: 'I’m signed in: linkedin.com' });
    await click(confirm);
    await waitFor(() =>
      expect(view.requests.some((r) => r.path.endsWith('/recording/confirm'))).toBe(true),
    );
    await waitFor(() =>
      expect(screen.getByText(/1 of 2 sites signed in\. linkedin\.com signed in\./)).toBeDefined(),
    );
    await click(screen.getByRole('button', { name: 'Finish' }));
    // indeed.com is not signed in: the dialog warns and keeps signing in as the primary action.
    const dialog = await screen.findByRole('dialog', {
      name: 'Finish without every site signed in?',
    });
    expect(within(dialog).getByText('indeed.com isn’t confirmed yet')).toBeDefined();
    expect(
      within(dialog).getByText(
        'You haven’t confirmed indeed.com yet: sign in there, then press I’m signed in.',
      ),
    ).toBeDefined();
    expect(within(dialog).getByText('google.com')).toBeDefined();
    await expectNoA11yViolations(dialog, { disable: ['aria-hidden-focus'] });
    await click(within(dialog).getByRole('button', { name: 'Finish anyway' }));
    const finish = view.requests.find((r) => r.path.endsWith('/recording/finish'));
    expect(finish?.body).toEqual({ remove_sign_ins: ['google.com'] });
    // The ready summary follows at once (no stale "window open" view until the next poll).
    expect(await screen.findByText(/is ready, but 1 site isn’t signed in/)).toBeDefined();
    expect(screen.queryByRole('button', { name: /Done, close the window/ })).toBeNull();
  }, 20_000);

  it('shows the error state of a refused start', async () => {
    const fake = server({
      existing: true,
      startError: { status: 429, code: 'SESSION_LIMIT_REACHED' },
    });
    const view = mount(`/templates/new?step=5&template=${ID}`, fake);
    await click(await screen.findByRole('button', { name: 'Open the sign-in window' }));
    expect(await screen.findByText('No browser slot is free')).toBeDefined();
    await expectNoA11yViolations(view.container);
  });
});

describe('NewTemplatePage edges', () => {
  it('sends step 5 without a template back to the last step', async () => {
    sessionStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({ name: 'job-hunt', sites: ['linkedin.com'], access: 'all' }),
    );
    const view = mount('/templates/new?step=5');
    await waitFor(() => expect(view.router.state.location.search).toMatchObject({ step: 4 }));
  });

  it('warns on the ready screen when a site is signed out and offers Sign in again', async () => {
    const fake = server({ existing: true });
    const view = mount(`/templates/new?step=5&template=${ID}`, {
      routes: {
        ...fake.routes,
        [`GET /templates/${ID}`]: templateDetail({
          template_id: ID,
          status: 'ready',
          sites: [signedInSite('linkedin.com'), templateSite('indeed.com')],
        }),
      },
    });
    expect(await screen.findByText(/is ready, but 1 site isn’t signed in/)).toBeDefined();
    await expectNoA11yViolations(view.container);
    await click(screen.getByRole('button', { name: 'Sign in again' }));
    await waitFor(() => expect(view.router.state.location.search).toMatchObject({ again: 1 }));
    expect(view.requests.some((r) => r.method === 'POST' && r.path.endsWith('/recording'))).toBe(
      true,
    );
  });
});

describe('NewTemplatePage ready screen', () => {
  it('does not count a site it could not tell about as signed out', async () => {
    const fake = server({ existing: true });
    mount(`/templates/new?step=5&template=${ID}`, {
      routes: {
        ...fake.routes,
        [`GET /templates/${ID}`]: templateDetail({
          template_id: ID,
          display_name: 'Job hunt',
          status: 'ready',
          sites: [
            signedInSite('linkedin.com'),
            templateSite('indeed.com', {
              health: {
                state: 'inconclusive',
                reason: 'no_signal',
                checked_at: 1,
                changed_at: 1,
                consecutive_inconclusive: 1,
              },
            }),
          ],
        }),
      },
    });
    expect(await screen.findByText('Job hunt is ready')).toBeDefined();
    expect(screen.getByText(/Couldn't tell/)).toBeDefined();
  });
});

describe('NewTemplatePage Cancel and the draft', () => {
  it('Cancel on step 1 with nothing entered leaves at once', async () => {
    const view = mount('/templates/new');
    await screen.findByRole('heading', { level: 2, name: 'Name' });
    await click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => expect(view.router.state.location.pathname).toBe('/templates'));
    expect(sessionStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  it('Cancel on step 1 with a typed name asks first: Keep editing stays, Discard forgets it', async () => {
    const view = mount('/templates/new');
    fireEvent.change(await screen.findByLabelText(/Display name/), {
      target: { value: 'Job hunt' },
    });
    expect(sessionStorage.getItem(DRAFT_KEY)).not.toBeNull();
    await click(screen.getByRole('button', { name: 'Cancel' }));
    let dialog = await screen.findByRole('alertdialog', {
      name: 'Discard this template setup?',
    });
    await expectNoA11yViolations(dialog, { disable: ['aria-hidden-focus'] });
    // Keep editing stays on the step with the draft kept.
    await click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(view.router.state.location.pathname).toBe('/templates/new');
    expect(sessionStorage.getItem(DRAFT_KEY)).not.toBeNull();
    await click(screen.getByRole('button', { name: 'Cancel' }));
    dialog = await screen.findByRole('alertdialog', { name: 'Discard this template setup?' });
    await click(within(dialog).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(view.router.state.location.pathname).toBe('/templates'));
    expect(sessionStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  for (const step of [2, 3, 4] as const) {
    it(`Cancel on step ${step} asks first, then Discard forgets the draft`, async () => {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify(FULL_DRAFT));
      const view = mount(`/templates/new?step=${step}`);
      await settle();
      expect(screen.getByRole('heading', { level: 2, name: STEP_LABEL[step] })).toBeDefined();
      expect(screen.getByRole('button', { name: 'Back' })).toBeDefined();
      await click(await screen.findByRole('button', { name: 'Cancel' }));
      const dialog = await screen.findByRole('alertdialog', {
        name: 'Discard this template setup?',
      });
      await click(within(dialog).getByRole('button', { name: 'Discard' }));
      await waitFor(() => expect(view.router.state.location.pathname).toBe('/templates'));
      expect(sessionStorage.getItem(DRAFT_KEY)).toBeNull();
      expect(view.requests.some((r) => r.method === 'POST' && r.path === '/api/v1/templates')).toBe(
        false,
      );
    });
  }

  it('after Cancel the wizard starts empty on step 1', async () => {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(FULL_DRAFT));
    const first = mount('/templates/new?step=3');
    await settle();
    await click(await screen.findByRole('button', { name: 'Cancel' }));
    const dialog = await screen.findByRole('alertdialog');
    await click(within(dialog).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(first.router.state.location.pathname).toBe('/templates'));
    first.unmount();

    mount('/templates/new');
    await screen.findByRole('heading', { level: 2, name: 'Name' });
    expect((screen.getByLabelText(/Name for agents/) as HTMLInputElement).value).toBe('');
  });

  it('keeps the draft in this tab only and drops an old localStorage copy unread', async () => {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...FULL_DRAFT, name: 'from-last-week' }));
    mount('/templates/new');
    await screen.findByRole('heading', { level: 2, name: 'Name' });
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
    expect((screen.getByLabelText(/Name for agents/) as HTMLInputElement).value).toBe('');
    fireEvent.change(screen.getByLabelText(/Display name/), { target: { value: 'Job hunt' } });
    expect(JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? '{}')).toMatchObject({
      name: 'job-hunt',
    });
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  it('a visit without ?step starts on step 1, the same-tab draft prefilled', async () => {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(FULL_DRAFT));
    const view = mount('/templates/new');
    await screen.findByRole('heading', { level: 2, name: 'Name' });
    expect((screen.getByLabelText(/Name for agents/) as HTMLInputElement).value).toBe('job-hunt');
    // The system answer (which arms the deep-link guard) does not move it either.
    await waitFor(() => expect(view.requests.some((r) => r.path === '/api/v1/system')).toBe(true));
    await settle();
    expect(view.router.state.location.search).toEqual({});
    expect(screen.getByRole('heading', { level: 2, name: 'Name' })).toBeDefined();
  });

  it('a deep link past an empty step lands on it, and Cancel still leaves', async () => {
    const view = mount('/templates/new?step=4');
    await waitFor(() => expect(view.router.state.location.search).toMatchObject({ step: 1 }));
    await click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(view.router.state.location.pathname).toBe('/templates'));
  });

  it('Cancel setup on the sign-in step deletes the template after a confirmation; axe clean', async () => {
    sessionStorage.setItem(CREATED_KEY, JSON.stringify([ID]));
    const view = mount(`/templates/new?step=5&template=${ID}`, server({ existing: true }));
    const cancel = await screen.findByRole('button', { name: 'Cancel setup' });
    expect(screen.getByRole('button', { name: 'Finish later' })).toBeDefined();
    await click(cancel);
    let dialog = await screen.findByRole('alertdialog', {
      name: 'Cancel setting up Template 7?',
    });
    expect(within(dialog).getByText(/template and its browser profile are deleted/)).toBeDefined();
    await expectNoA11yViolations(dialog, { disable: ['aria-hidden-focus'] });
    await click(within(dialog).getByRole('button', { name: 'Keep setting up' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(view.requests.some((r) => r.method === 'DELETE')).toBe(false);

    await click(screen.getByRole('button', { name: 'Cancel setup' }));
    dialog = await screen.findByRole('alertdialog', { name: 'Cancel setting up Template 7?' });
    await click(within(dialog).getByRole('button', { name: 'Delete template' }));
    await waitFor(() => expect(view.router.state.location.pathname).toBe('/templates'));
    const del = view.requests.find((r) => r.method === 'DELETE');
    expect(del?.path).toBe(`/api/v1/templates/${ID}`);
    // Only while it is still being set up, and never closing a session (review #85 M2).
    expect(del?.query.get('force')).toBe('false');
    expect(del?.query.get('if_status')).toBe('recording');
    expect(JSON.parse(sessionStorage.getItem(CREATED_KEY) ?? '[]')).toEqual([]);
  });

  it('no Cancel setup for a template this tab did not create, or one that is disabled', async () => {
    const first = mount(`/templates/new?step=5&template=${ID}`, server({ existing: true }));
    await screen.findByRole('button', { name: 'Finish later' });
    expect(screen.queryByRole('button', { name: 'Cancel setup' })).toBeNull();
    first.unmount();

    sessionStorage.setItem(CREATED_KEY, JSON.stringify([ID]));
    const fake = server({ existing: true });
    mount(`/templates/new?step=5&template=${ID}`, {
      routes: {
        ...fake.routes,
        [`GET /templates/${ID}`]: templateDetail({ template_id: ID, status: 'disabled' }),
      },
    });
    await screen.findByRole('button', { name: 'Finish later' });
    expect(screen.queryByRole('button', { name: 'Cancel setup' })).toBeNull();
  });

  it('Cancel setup deletes nothing when another tab finished the template meanwhile', async () => {
    sessionStorage.setItem(CREATED_KEY, JSON.stringify([ID]));
    const fake = server({ existing: true });
    let reads = 0;
    const view = mount(`/templates/new?step=5&template=${ID}`, {
      routes: {
        ...fake.routes,
        // The step loaded it being set up; by the time Cancel setup reads it again it is ready.
        [`GET /templates/${ID}`]: () => {
          reads += 1;
          return templateDetail({
            template_id: ID,
            status: reads <= 1 ? 'recording' : 'ready',
            sites: [templateSite('linkedin.com')],
          });
        },
      },
    });
    await click(await screen.findByRole('button', { name: 'Cancel setup' }));
    const dialog = await screen.findByRole('alertdialog', { name: /^Cancel setting up/ });
    await click(within(dialog).getByRole('button', { name: 'Delete template' }));
    expect(
      (await screen.findAllByText('This template is no longer being set up')).length,
    ).toBeGreaterThan(0);
    expect(view.requests.some((r) => r.method === 'DELETE')).toBe(false);
    expect(view.router.state.location.pathname).toBe('/templates/new');
  });

  it('a server refusal (finished elsewhere: 409) leaves the step as it is', async () => {
    sessionStorage.setItem(CREATED_KEY, JSON.stringify([ID]));
    const fake = server({ existing: true });
    const view = mount(`/templates/new?step=5&template=${ID}`, {
      routes: { ...fake.routes, [`DELETE /templates/${ID}`]: problem(409, 'CONFLICT') },
    });
    await click(await screen.findByRole('button', { name: 'Cancel setup' }));
    const dialog = await screen.findByRole('alertdialog', { name: /^Cancel setting up/ });
    await click(within(dialog).getByRole('button', { name: 'Delete template' }));
    await waitFor(() => expect(view.requests.some((r) => r.method === 'DELETE')).toBe(true));
    expect(view.router.state.location.pathname).toBe('/templates/new');
    expect(screen.getByRole('button', { name: 'Cancel setup' })).toBeDefined();
  });

  it('a ready template offers no Cancel setup', async () => {
    sessionStorage.setItem(CREATED_KEY, JSON.stringify([ID]));
    const fake = server({ existing: true });
    mount(`/templates/new?step=5&template=${ID}&again=1`, {
      routes: {
        ...fake.routes,
        [`GET /templates/${ID}`]: templateDetail({ template_id: ID, status: 'ready' }),
      },
    });
    await screen.findByRole('button', { name: /^Done/ });
    expect(screen.queryByRole('button', { name: 'Cancel setup' })).toBeNull();
  });
});

describe('RemoteOperatorBanner', () => {
  it('says the window opens on the BrowserHive machine, not here; axe clean', async () => {
    const view = render(<RemoteOperatorBanner host="hive.lan" />);
    expect(screen.getByText('This opens a window on hive.lan, not on this device')).toBeDefined();
    await expectNoA11yViolations(view.container);
  });

  it('renders nothing for a local operator', () => {
    const view = render(<RemoteOperatorBanner host={null} />);
    expect(view.container.textContent).toBe('');
  });
});

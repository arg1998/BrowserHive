/** @module features/templates/wizard/NewTemplatePage.test — the new-template wizard over fake routes: steps in the URL with focus on the step heading, the name suggested from the display name, `POST /templates` with the draft, a taken name sent back to step 1, then the sign-in step: open the window, I'm signed in, Finish with an unlisted sign-in removed, the ready screen; a refused start shows its error state; the remote-operator notice; axe on every step */
import { beforeEach, describe, expect, it } from 'bun:test';
import type { Template } from '@browserhive/contracts/http';
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
import { DRAFT_KEY } from './draft.ts';
import { NewTemplatePage } from './NewTemplatePage.tsx';

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
      [`GET /templates/${ID}`]: () => detail(),
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

function mount(url: string, fake = server()) {
  return renderPage({
    path: '/templates/new',
    component: NewTemplatePage,
    validateSearch: (s) => wizardSearch.parse(s),
    routes: fake.routes,
    url,
  });
}

const click = async (element: HTMLElement) => {
  await act(async () => {
    fireEvent.click(element);
  });
};

beforeEach(() => {
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
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
  }, 20_000);

  it('sends a taken name back to step 1', async () => {
    localStorage.setItem(
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
    await screen.findByText(/The sign-in window is open on this computer/, undefined, {
      timeout: 3000,
    });
    const confirm = screen.getAllByRole('button', { name: /I'm signed in to/ })[0] as HTMLElement;
    await click(confirm);
    await waitFor(() =>
      expect(view.requests.some((r) => r.path.endsWith('/recording/confirm'))).toBe(true),
    );
    await click(screen.getByRole('button', { name: 'Finish' }));
    const dialog = await screen.findByRole('dialog', { name: 'Finish signing in?' });
    expect(within(dialog).getByText('google.com')).toBeDefined();
    await expectNoA11yViolations(dialog, { disable: ['aria-hidden-focus'] });
    await click(within(dialog).getByRole('button', { name: 'Finish' }));
    const finish = view.requests.find((r) => r.path.endsWith('/recording/finish'));
    expect(finish?.body).toEqual({ remove_sign_ins: ['google.com'] });
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

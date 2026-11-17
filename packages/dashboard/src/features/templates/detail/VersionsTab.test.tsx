/** @module features/templates/detail/VersionsTab.test — the Versions tab with health (spec 13 §8.5, PR T2): a version written by a re-login reads "Re-login", each version shows the per-site sign-in it was written with (incomplete sign-ins and sites not offered said in words), Last good, pinning, and a new version arriving over `template.version`; axe clean */
import { describe, expect, it } from 'bun:test';
import {
  templateDetail,
  tid,
  versionRow,
  versionsPage,
} from '../../../../test/fixtures/templates.ts';
import { expectNoA11yViolations } from '../../../../test/helpers/axe.ts';
import { renderPage } from '../../../../test/helpers/page-harness.tsx';
import { act, fireEvent, screen, waitFor, within } from '../../../../test/helpers/render.tsx';
import { templatePageSearch } from '../search.ts';
import { TemplatePage } from './TemplatePage.tsx';
import { reasonText } from './version-text.ts';

const ID = tid(1);

const RELOGIN = versionRow(3, {
  reason: 'relogin',
  last_good: true,
  health: [
    { site_id: 'linkedin.com', state: 'signed_in', enabled: true, sign_in_complete: true },
    { site_id: 'indeed.com', state: 'signed_out', enabled: false, sign_in_complete: false },
  ],
});

function mount(rows = [RELOGIN, versionRow(2), versionRow(1, { last_good: false })]) {
  return renderPage({
    path: '/templates/$id',
    component: TemplatePage,
    validateSearch: (s) => templatePageSearch.parse(s),
    routes: {
      [`GET /templates/${ID}`]: templateDetail({ current_version: 3 }),
      [`GET /templates/${ID}/versions`]: versionsPage(rows),
      [`PATCH /templates/${ID}/versions/3`]: { version: { ...RELOGIN, pinned: true } },
      'GET /system': { vault: { enabled: false, backend: null } },
    },
    url: `/templates/${ID}?tab=versions`,
  });
}

describe('Versions tab', () => {
  it('names a re-login version and shows the health it was written with; axe clean', async () => {
    const view = mount();
    const row = (await screen.findByText('Version 3')).closest('li') as HTMLElement;
    expect(within(row).getByText('Re-login')).toBeDefined();
    expect(within(row).getByText('Last good')).toBeDefined();
    const health = within(row).getByRole('list', { name: 'Sign-in when written' });
    expect(within(health).getByText('signed in')).toBeDefined();
    expect(
      within(health).getByText('signed out, some sign-in cookies missing, not offered'),
    ).toBeDefined();
    await expectNoA11yViolations(view.container, { disable: ['aria-hidden-focus'] });
  });

  it('pins a version', async () => {
    const view = mount();
    const row = (await screen.findByText('Version 3')).closest('li') as HTMLElement;
    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: 'Pin version 3' }));
    });
    await waitFor(() => {
      const patch = view.requests.find((r) => r.method === 'PATCH');
      expect(patch?.body).toEqual({ pinned: true });
    });
  });

  it('reloads the list when a version is written', async () => {
    const view = mount();
    await screen.findByText('Version 3');
    const before = view.requests.filter((r) => r.path.endsWith('/versions')).length;
    view.connect();
    view.emit('templates', { type: 'template.version', template_id: ID, version: versionRow(4) });
    await waitFor(() =>
      expect(view.requests.filter((r) => r.path.endsWith('/versions')).length).toBeGreaterThan(
        before,
      ),
    );
  });

  it('words every reason', () => {
    expect(reasonText({ reason: 'relogin', restored_from: null })).toBe('Re-login');
    expect(reasonText({ reason: 'restore', restored_from: 0 })).toBe(
      'Restored from the checkpoint',
    );
    expect(reasonText({ reason: 'restore', restored_from: 2 })).toBe('Restored from version 2');
  });
});

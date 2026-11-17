/** @module features/templates/wizard/SignInState.test — what the sign-in step says about each site before Finish (owner report 2026-11-17): a pack site found signed in by its cookies, a pack site still being waited for, a site without a pack not confirmed yet with a primary **I'm signed in**, a host-start "signed out" never shown as such; the Finish dialog says what is missing per kind of site; axe clean */
import { describe, expect, it } from 'bun:test';
import type { TemplateSiteView } from '@browserhive/contracts/http';
import { signedInSite, templateSite } from '../../../../test/fixtures/templates.ts';
import { expectNoA11yViolations } from '../../../../test/helpers/axe.ts';
import { render, screen, within } from '../../../../test/helpers/render.tsx';
import { FinishDialog } from './FinishDialog.tsx';
import { SignInSites, signInStateText } from './SignInSites.tsx';

const health = (
  state: TemplateSiteView['health']['state'],
  reason: string | null,
): TemplateSiteView['health'] => ({
  state,
  reason,
  checked_at: 1,
  changed_at: 1,
  consecutive_inconclusive: 0,
});

/** LinkedIn detected, GitHub (a pack) still being waited for, a generic site not confirmed. */
const SITES = [
  templateSite('linkedin.com', {
    pack_id: 'linkedin.com',
    health: health('signed_in', 'detected_by_pack_cookies'),
  }),
  // The browser's first start probed before anyone signed in.
  templateSite('github.com', {
    pack_id: 'github.com',
    health: health('signed_out', 'cookies_absent'),
  }),
  templateSite('shop.test', { health: health('unknown', null) }),
];

describe('sign-in step states', () => {
  it('says per site what happens next, never "Signed out" before Finish; axe clean', async () => {
    const view = render(
      <SignInSites
        sites={SITES}
        windowOpen={true}
        pending={null}
        errors={{}}
        onConfirm={() => undefined}
      />,
    );
    const row = (site: string) =>
      screen.getByText(site, { selector: 'span' }).closest('li') as HTMLElement;
    expect(
      within(row('linkedin.com')).getByText(/^Signed in: BrowserHive found its sign-in/),
    ).toBeDefined();
    expect(
      within(row('github.com')).getByText('Not signed in yet: BrowserHive notices when you are'),
    ).toBeDefined();
    expect(within(row('github.com')).queryByRole('button')).toBeNull();
    expect(
      within(row('shop.test')).getByText('Not confirmed yet: sign in, then press I’m signed in'),
    ).toBeDefined();
    expect(
      within(row('shop.test')).getByRole('button', { name: 'I’m signed in: shop.test' }),
    ).toBeDefined();
    expect(view.container.textContent).not.toContain('Signed out');
    await expectNoA11yViolations(view.container);
  });

  it('a challenged site keeps its warning; without a window the hints go', () => {
    expect(
      signInStateText(templateSite('a.test', { health: health('challenged', 'captcha') }), true),
    ).toEqual({ text: 'Check needed', tone: 'warn' });
    expect(signInStateText(templateSite('a.test'), false).text).toBe('Not confirmed yet');
    expect(signInStateText(templateSite('a.test', { pack_id: 'a.test' }), false).text).toBe(
      'Not signed in yet',
    );
    expect(signInStateText(signedInSite('a.test'), true).text).toBe('Signed in');
  });
});

describe('Finish dialog', () => {
  it('says what is missing for each kind of site; axe clean', async () => {
    render(
      <FinishDialog
        open={true}
        onOpenChange={() => undefined}
        sites={SITES}
        unlisted={[]}
        finishing={false}
        onFinish={() => undefined}
      />,
    );
    const dialog = await screen.findByRole('dialog', {
      name: 'Finish without every site signed in?',
    });
    expect(within(dialog).getByText('2 of 3 sites aren’t signed in yet')).toBeDefined();
    expect(
      within(dialog).getByText(
        'You haven’t confirmed shop.test yet: sign in there, then press I’m signed in.',
      ),
    ).toBeDefined();
    expect(
      within(dialog).getByText(
        'BrowserHive hasn’t found a sign-in on github.com yet; it checks once more when you finish.',
      ),
    ).toBeDefined();
    expect(within(dialog).queryByText(/No site is signed in/)).toBeNull();
    expect(within(dialog).queryByText('Also signed in to')).toBeNull();
    await expectNoA11yViolations(dialog, { disable: ['aria-hidden-focus'] });
  });

  it('every site signed in: nothing to warn about', async () => {
    render(
      <FinishDialog
        open={true}
        onOpenChange={() => undefined}
        sites={[SITES[0] as TemplateSiteView]}
        unlisted={[]}
        finishing={false}
        onFinish={() => undefined}
      />,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Finish signing in?' });
    expect(within(dialog).getByText('Every site is signed in.')).toBeDefined();
  });
});

/** @module features/sessions/live/TakeoverOrigin.test — the takeover's origin strip for template sessions (spec 13 §8.4): the page's origin always shown, a warning when its host is not on one of the template's sites, a warning on an unencrypted page, a neutral can't-check while the sites load or can't be read, nothing for an exclusive session or a page without a web origin; axe clean */
import { describe, expect, it } from 'bun:test';
import type { SessionSummary } from '@browserhive/contracts/http';
import { sessionSummary } from '../../../../test/fixtures/sessions.ts';
import { templateDetail, tid } from '../../../../test/fixtures/templates.ts';
import { expectNoA11yViolations } from '../../../../test/helpers/axe.ts';
import { renderPage } from '../../../../test/helpers/page-harness.tsx';
import { screen, waitFor, within } from '../../../../test/helpers/render.tsx';
import { pageOrigin, TakeoverOrigin } from './TakeoverOrigin.tsx';

const ID = tid(1);
const TEMPLATE = { template_id: ID, name: 'job-hunt', version: null, mode: 'live' } as const;

function mount(session: SessionSummary, detail: unknown = templateDetail()) {
  return renderPage({
    path: '/',
    component: () => <TakeoverOrigin session={session} />,
    // `null`: the template can't be read (404, as for an operator without `templates:read`).
    routes: detail === null ? {} : { [`GET /templates/${ID}`]: detail },
    url: '/',
  });
}

describe('TakeoverOrigin', () => {
  it('shows the origin of a page on one of the template’s sites, without a warning; axe clean', async () => {
    const view = mount(
      sessionSummary(1, { template: TEMPLATE, current_url: 'https://www.linkedin.com/login?x=1' }),
    );
    expect(await screen.findByText('https://www.linkedin.com')).toBeDefined();
    await expectNoA11yViolations(view.container);
    const strip = screen.getByTestId('takeover-origin');
    expect(strip.getAttribute('data-foreign')).toBe('false');
    expect(strip.getAttribute('data-check')).toBe('ok');
    expect(within(strip).queryByRole('alert')).toBeNull();
  });

  it('warns when the page is not on one of the template’s sites', async () => {
    mount(
      sessionSummary(1, { template: TEMPLATE, current_url: 'https://linkedin.com.sign-in.test/' }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('takeover-origin').getAttribute('data-foreign')).toBe('true'),
    );
    const alert = within(screen.getByTestId('takeover-origin')).getByRole('alert');
    expect(alert.textContent).toContain(
      'not on one of Job hunt’s sites (linkedin.com, indeed.com)',
    );
    expect(screen.getByText('https://linkedin.com.sign-in.test')).toBeDefined();
  });

  it('warns on an unencrypted page, even on one of the template’s sites; axe clean', async () => {
    const view = mount(
      sessionSummary(1, { template: TEMPLATE, current_url: 'http://linkedin.com/login' }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('takeover-origin').getAttribute('data-check')).toBe('insecure'),
    );
    const alert = within(screen.getByTestId('takeover-origin')).getByRole('alert');
    expect(alert.textContent).toContain('This page is not encrypted (http:)');
    await expectNoA11yViolations(view.container);
  });

  it('is neutral while the template’s sites load: never the all-clear', async () => {
    mount(
      sessionSummary(1, { template: TEMPLATE, current_url: 'https://linkedin.com.sign-in.test/' }),
      () => new Promise(() => undefined),
    );
    const strip = await screen.findByTestId('takeover-origin');
    expect(strip.getAttribute('data-check')).toBe('unknown');
    expect(within(strip).getByText('Checking it against the template’s sites…')).toBeDefined();
    expect(within(strip).queryByRole('alert')).toBeNull();
  });

  it('says it can’t check when the template can’t be read (no templates:read); axe clean', async () => {
    const view = mount(
      sessionSummary(1, { template: TEMPLATE, current_url: 'https://evil.test/' }),
      null,
    );
    expect(await screen.findByText(/Can’t check it against the template’s sites/)).toBeDefined();
    expect(screen.getByTestId('takeover-origin').getAttribute('data-check')).toBe('unknown');
    await expectNoA11yViolations(view.container);
  });

  it('shows nothing for an exclusive session', () => {
    const view = mount(sessionSummary(1, { current_url: 'https://evil.test/' }));
    expect(view.container.querySelector('[data-testid="takeover-origin"]')).toBeNull();
  });

  it('reads only web origins, without credentials', () => {
    expect(pageOrigin('https://user:pw@a.example.com/x')).toEqual({
      origin: 'https://a.example.com',
      host: 'a.example.com',
      secure: true,
    });
    expect(pageOrigin('http://a.example.com/')?.secure).toBe(false);
    expect(pageOrigin('about:blank')).toBeNull();
    expect(pageOrigin(null)).toBeNull();
  });
});

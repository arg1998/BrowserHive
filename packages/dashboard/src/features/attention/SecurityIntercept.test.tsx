/** @module features/attention/SecurityIntercept.test — `security_intercept` requests on `/attention` (spec 13 §9.3, §9.5, §11.4, T3a): "Write approval" with the site, guard and kind, method and sanitized URL as text (never a link or markup) and the tool, Approve and Deny mapped to resolve and reject, the note that non-`write` guards can only be decided here; "Site check" with its challenge; malformed options shown as neither; history labels; axe clean */
import { describe, expect, it } from 'bun:test';
import { expectNoA11yViolations } from '../../../test/helpers/axe.ts';
import { envelope, renderPage } from '../../../test/helpers/page-harness.tsx';
import { act, fireEvent, screen, waitFor, within } from '../../../test/helpers/render.tsx';
import { AttentionPage } from './AttentionPage.tsx';
import { requestRow } from './fixtures.ts';
import { interceptOf } from './SecurityIntercept.tsx';
import { attentionSearch } from './search.ts';

const WRITE = requestRow({
  request_id: 'a-WWWWWWWWWWWW',
  kind: 'security_intercept',
  reason: 'LinkedIn wants to send an invitation',
  mode: 'notify',
  template_id: 'tp-0000000001',
  options: {
    reason: 'write_confirm',
    site: 'linkedin.com',
    site_title: 'LinkedIn',
    pack_id: 'linkedin.com',
    template_id: 'tp-0000000001',
    guard: { id: 'logout', kind: 'logout' },
    method: 'POST',
    url: 'https://www.linkedin.com/m/logout?<b>x</b>',
    tool: 'click',
    source: 'element',
  },
});
const CHECK = requestRow({
  request_id: 'a-CCCCCCCCCCCC',
  kind: 'security_intercept',
  reason: 'LinkedIn security check',
  mode: 'takeover',
  options: {
    reason: 'challenge',
    site: 'linkedin.com',
    site_title: 'LinkedIn',
    pack_id: 'linkedin.com',
    template_id: 'tp-0000000001',
    challenge: { id: 'checkpoint', kind: 'checkpoint', action: 'stop' },
  },
});
const MALFORMED = requestRow({
  request_id: 'a-MMMMMMMMMMMM',
  kind: 'security_intercept',
  reason: 'Odd one',
  mode: 'notify',
  options: { reason: 'something else' },
});

function setup() {
  return renderPage({
    path: '/attention',
    component: AttentionPage,
    validateSearch: (s) => attentionSearch.parse(s),
    url: '/attention',
    routes: {
      'GET /system': { vault: { enabled: false, backend: null } },
      'GET /me/preferences': { preferences: {}, updated_at: null },
      'GET /attention': (req: { query: URLSearchParams }) =>
        req.query.get('status') === 'pending'
          ? envelope([WRITE, CHECK, MALFORMED], { open_count: 3 })
          : envelope([{ ...WRITE, status: 'resolved', request_id: 'a-HHHHHHHHHHHH' }], {
              open_count: 3,
              facets: { status: [], mode: [] },
            }),
      'GET /sessions/shop-ab12cd34/screenshots': envelope([]),
      'POST /attention/a-WWWWWWWWWWWW/resolve': { ok: true, status: 'resolved' },
    },
  });
}

describe('security intercepts on /attention', () => {
  it('labels a write approval and a site check with their facts as text; axe clean', async () => {
    const view = setup();
    const write = await screen.findByRole('article', {
      name: 'LinkedIn wants to send an invitation',
    });
    expect(within(write).getByText('Write approval')).toBeDefined();
    expect(within(write).getByText('logout')).toBeDefined();
    expect(within(write).getByText(/sign-out/)).toBeDefined();
    expect(within(write).getByText('POST')).toBeDefined();
    // The URL is text: the markup inside it is shown, never parsed or linked.
    const url = within(write).getByText(/linkedin\.com\/m\/logout\?<b>x<\/b>/);
    expect(url.closest('a')).toBeNull();
    expect(write.querySelector('b')).toBeNull();
    expect(within(write).getByText('click')).toBeDefined();
    expect(within(write).getByText(/can only be decided here/)).toBeDefined();
    expect(within(write).getByRole('button', { name: 'Approve' })).toBeDefined();
    expect(within(write).getByRole('button', { name: 'Deny' })).toBeDefined();

    const check = screen.getByRole('article', { name: 'LinkedIn security check' });
    expect(within(check).getByText('Site check')).toBeDefined();
    expect(within(check).getByText('Checkpoint')).toBeDefined();
    expect(within(check).getByText(/stays stopped until cleared/)).toBeDefined();
    expect(within(check).getByRole('button', { name: 'Resolve' })).toBeDefined();
    expect(within(check).queryByText(/can only be decided here/)).toBeNull();

    const odd = screen.getByRole('article', { name: 'Odd one' });
    expect(within(odd).queryByText('Write approval')).toBeNull();
    expect(within(odd).queryByText('Site check')).toBeNull();

    const history = await screen.findByRole('region', { name: 'Settled requests' });
    expect(within(history).getByText('Write approval:')).toBeDefined();
    await expectNoA11yViolations(view.container, { disable: ['aria-hidden-focus'] });
  });

  it('Approve resolves the request', async () => {
    const view = setup();
    const write = await screen.findByRole('article', {
      name: 'LinkedIn wants to send an invitation',
    });
    await act(async () => {
      fireEvent.click(within(write).getByRole('button', { name: 'Approve' }));
    });
    await waitFor(() =>
      expect(view.requests.some((r) => r.path.endsWith('/a-WWWWWWWWWWWW/resolve'))).toBe(true),
    );
  });

  it('parses options and ignores other kinds', () => {
    expect(interceptOf({ kind: 'attention', options: WRITE['options'] })).toBeNull();
    expect(interceptOf({ kind: 'security_intercept', options: { reason: 'x' } })).toBeNull();
    expect(
      interceptOf({ kind: 'security_intercept', options: WRITE['options'] })?.guard?.kind,
    ).toBe('logout');
  });
});

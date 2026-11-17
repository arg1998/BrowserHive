/** @module test/helpers/https-sites-strategies — the network-strategy pages of the HTTPS fixture sites (spec 13 §9.4, T3b WP-N): a burst of guarded writes (`pace-writes`), a response carrying the DBSC registration header (`device-bound-session`), a keeper path (`keep-alive`), a Reddit-shaped probe page that redirects to the sign-in page client-side after `load` and one that stays (D48). */

/** How long after `load` the Reddit-shaped page navigates to `/login` (client-side, D48). */
export const CLIENT_REDIRECT_AFTER_LOAD_MS = 800;

const html = (title: string, body: string, headers: Record<string, string> = {}): Response =>
  new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`,
    { headers: { 'content-type': 'text/html; charset=utf-8', ...headers } },
  );

/** The strategy pages, or `null` for any other path. */
export function strategyRoute(path: string): Response | null {
  switch (path) {
    case '/strategies/burst':
      // Five guarded writes at once; their outcomes land in `#out` once all settled.
      return html(
        'burst',
        `<button id="burst" onclick="Promise.all([1, 2, 3, 4, 5].map((n) => fetch('/api/invite?n=' + n, {method: 'POST', body: 'x'}).then((r) => 'sent ' + r.status, () => 'blocked'))).then((all) => { document.getElementById('out').textContent = all.join(','); })">burst</button><pre id="out"></pre>`,
      );
    case '/strategies/dbsc':
      return html('dbsc', '<p id="dbsc">bound</p>', {
        'sec-session-registration':
          '(ES256 RS256);path="/strategies/dbsc-start";challenge="fixture"',
      });
    case '/strategies/plain':
      return html('plain', '<p id="plain">plain</p>');
    case '/strategies/keep':
      return html('keep', '<div id="feed">kept</div>');
    case '/strategies/reddit':
      // Answers 200 and is still here at DOMContentLoaded and at load; then the app sends a
      // signed-out browser to the sign-in page (Reddit's /settings/account, D48).
      return html(
        'settings',
        `<p id="app">loading</p><script>addEventListener('load', () => setTimeout(() => location.replace('/login/?dest=' + encodeURIComponent(location.href)), ${CLIENT_REDIRECT_AFTER_LOAD_MS}))</script>`,
      );
    case '/strategies/stays':
      return html('settings', '<p id="app">settings</p>');
    default:
      return null;
  }
}

/** @module test/helpers/https-sites-strategies — the strategy pages of the HTTPS fixture sites (spec 13 §9.4, §14). Before-action strategies: an input page that records pointer moves and key timings in the DOM (humanized input), warm-up entries that leave the pack's domains by a server redirect and by a script navigation (the fail-closed guard), and a page whose body arrives late (a long-running action). Network strategies: a burst of guarded writes (`pace-writes`), a response carrying the DBSC registration header (`device-bound-session`), a keeper path (`keep-alive`), a Reddit-shaped probe page that redirects to the sign-in page client-side after `load` and one that stays (D48). */

/** How long `/strategy/slow` waits before answering. */
export const STRATEGY_SLOW_MS = 4_000;

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
    case '/strategy/input':
      // Pointer moves and key intervals land in data attributes (readable without page scripts).
      return html(
        'input',
        `<input id="field"><button id="btn" style="margin:200px">go</button>
        <script>
          let moves = 0; let last = 0; const gaps = [];
          addEventListener('mousemove', (e) => { if (e.isTrusted) document.body.dataset.moves = String(++moves); });
          addEventListener('keydown', () => { const now = performance.now(); if (last) gaps.push(Math.round(now - last)); last = now; document.body.dataset.gaps = gaps.join(','); });
        </script>`,
      );
    case '/strategy/leave':
      // A server redirect: the driver routes only the first URL of a chain (spec 13 §3.8).
      return new Response(null, {
        status: 302,
        headers: { location: 'https://site-b.test/landing?from=warmup-302' },
      });
    case '/strategy/leave-js':
      return html(
        'leaving',
        `<script>location.href = 'https://site-b.test/landing?from=warmup-js';</script>`,
      );
    case '/strategy/slow': {
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          await Bun.sleep(STRATEGY_SLOW_MS);
          controller.enqueue(
            new TextEncoder().encode('<!doctype html><title>slow</title><p>slow</p>'),
          );
          controller.close();
        },
      });
      return new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
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

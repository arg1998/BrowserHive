/** @module test/helpers/https-sites-packs — the site pack pages of the HTTPS fixture sites (spec 13 §9.3, §9.5, §8.1, §14): a page with guarded controls, a logout, challenge pages (a pack checkpoint, a redirect into it, a terminal stop page, a Cloudflare-style interstitial), pages with an invisible reCAPTCHA v3 anchor and an invisible Turnstile-style frame, the probe pages, and the fake provider frames served for `challenges.cloudflare.com` and `www.google.com` (mapped to the fixture by the resolver rule of `startHttpsSites({ providers: true })`; no real provider script is ever loaded). */

import { strategyRoute } from './https-sites-strategies.ts';

/** Provider hosts the fixture answers when started with `providers: true`. */
export const FIXTURE_PROVIDER_HOSTS = ['challenges.cloudflare.com', 'www.google.com'] as const;

/** How long `/pack/probe/slow` waits before answering (a probe with a shorter timeout times out). */
export const SLOW_PROBE_MS = 6_000;

const html = (title: string, body: string, headers: Record<string, string> = {}): Response =>
  new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`,
    { headers: { 'content-type': 'text/html; charset=utf-8', ...headers } },
  );

const redirect = (to: string): Response =>
  new Response(null, { status: 302, headers: { location: to } });

/** A visible Turnstile-style widget frame (300 × 65, in the viewport). */
const TURNSTILE_FRAME =
  '<iframe id="cf" src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/turnstile" style="width:300px;height:65px;border:0"></iframe>';

/** A page whose body arrives after {@link SLOW_PROBE_MS} (`domcontentloaded` waits for it). */
function slowPage(): Response {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      await Bun.sleep(SLOW_PROBE_MS);
      controller.enqueue(new TextEncoder().encode('<!doctype html><title>slow</title><p>slow</p>'));
      controller.close();
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

/** The site pack pages, or `null` for any other path (reached through `guardRoute`). */
export function packRoute(path: string): Response | null {
  switch (path) {
    case '/pack/guarded':
      return html(
        'guarded',
        `<button id="signout" onclick="location.href='/logout'"><span id="signout-label">Sign out</span></button>
        <button id="safe" onclick="document.title='safe clicked'">Safe</button>
        <form id="search" action="/pack/searched"><input id="q" name="q"><button id="go">Search</button></form>
        <form id="danger" action="/logout"><input id="danger-field" name="d"><button id="danger-submit">Delete</button></form>
        <input id="focus-me">`,
      );
    case '/pack/searched':
      return html('searched', '<p id="searched">searched</p>');
    case '/logout':
      return html('signed out', '<p id="bye">signed out</p>');
    case '/pack/checkpoint':
      return html('Security checkpoint', '<p id="checkpoint">Let us check it is you</p>');
    case '/pack/go-checkpoint':
      return redirect('/pack/checkpoint');
    case '/pack/go-suspended':
      return redirect('/pack/suspended');
    case '/pack/suspended':
      return html('Account suspended', '<p id="suspended">Your account is suspended</p>');
    case '/pack/cf':
      // The Cloudflare interstitial shape: the title and a visible challenges.cloudflare.com frame.
      return html('Just a moment...', `<p>Checking your browser</p>${TURNSTILE_FRAME}`);
    case '/pack/turnstile':
      // A visible widget on an ordinary page: a provider surface (`notify`), not the interstitial.
      return html('sign in', `<p id="widget">sign in</p>${TURNSTILE_FRAME}`);
    case '/pack/recaptcha-v3':
      // reCAPTCHA v3's corner badge: an anchor with size=invisible, 256 × 60, partly off screen.
      return html(
        'v3',
        `<p id="v3">v3</p><div style="position:fixed;bottom:14px;right:-186px;width:256px;height:60px">
          <iframe src="https://www.google.com/recaptcha/api2/anchor?k=test&size=invisible" style="width:256px;height:60px;border:0"></iframe></div>`,
      );
    case '/pack/turnstile-invisible':
      return html(
        'invisible',
        '<p id="ti">invisible</p><iframe src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/turnstile?mode=invisible" style="display:none"></iframe>',
      );
    case '/pack/probe/in':
      return html('feed', '<div id="feed">feed</div>');
    case '/pack/probe/out':
      return redirect('/login?next=/pack/probe/out');
    case '/pack/probe/cf':
      return html('Just a moment...', TURNSTILE_FRAME);
    case '/pack/probe/slow':
      return slowPage();
    case '/pack/probe/forbidden':
      // A bot wall on the probe path (review #83 C-L5).
      return new Response('<!doctype html><title>Access denied</title><p>blocked</p>', {
        status: 403,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    case '/pack/posted':
      // A post quoting a block page's text (review #83 C-L1).
      return html(
        'a thread',
        '<article id="post">Mods: You have been blocked by network security?</article>',
      );
    case '/pack/probe/broken':
      return new Response('down', { status: 503 });
    // The fake provider frames (served for the provider hosts mapped to the fixture).
    case '/cdn-cgi/challenge-platform/turnstile':
      return html('turnstile', '<label><input type="checkbox"> Verify you are human</label>');
    case '/recaptcha/api2/anchor':
      return html('anchor', '<p>protected by reCAPTCHA</p>');
    default:
      return strategyRoute(path);
  }
}

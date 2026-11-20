/** @module test/helpers/https-sites — the HTTPS fixture sites of spec 13 §14: `https://site-a.test`, `site-b.test`, `idp.test` and `cdn-a.test` on one TLS listener with the checked-in `*.test` certificate; Chromium reaches them through the testing seam's resolver rule and SPKI pin. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clipboardRoute } from './https-sites-clipboard.ts';
import { guardRoute } from './https-sites-guards.ts';
import { FIXTURE_PROVIDER_HOSTS } from './https-sites-packs.ts';
import { signInRoute } from './https-sites-signin.ts';

const TLS_DIR = join(import.meta.dir, '..', 'fixtures', 'tls');

/** base64 SHA-256 of the fixture certificate's SubjectPublicKeyInfo (`--ignore-certificate-errors-spki-list`). */
export const FIXTURE_SPKI = 'OdxNBBcJTKjs+VKDDs/cKb78JMvnrW9GwTRLa3uEh/4=';

/** The fixture sites. */
export const FIXTURE_SITES = ['site-a.test', 'site-b.test', 'idp.test', 'cdn-a.test'] as const;

/** A running HTTPS fixture. */
export interface HttpsSites {
  readonly port: number;
  /** `https://<host>/<path>` (the resolver rule maps `*.test:443` to the listener). */
  url(host: string, path?: string): string;
  /** The Chromium switches of the testing seam (spec 13 §14). */
  readonly chromiumArgs: readonly string[];
  /** Requests seen: host, method, path and `Referer` (`null` when none was sent). */
  readonly requests: readonly {
    host: string;
    method: string;
    path: string;
    referer: string | null;
  }[];
  stop(): void;
}

const page = (title: string, body: string, head = ''): Response =>
  new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`,
    { headers: { 'content-type': 'text/html; charset=utf-8' } },
  );

/** The pages every site serves; `host` names the site. */
function route(host: string, path: string, method = 'GET', search = ''): Response {
  const site = host.split(':')[0] ?? host;
  switch (path) {
    case '/redir': {
      // An open redirect to wherever `to` says (spec 13 §3.8: the route never sees the hop).
      const to = new URLSearchParams(search).get('to') ?? '/';
      return new Response(null, { status: 302, headers: { location: to } });
    }
    case '/':
      return page(
        site,
        `<h1 id="site">${site}</h1>
        <a id="blank" target="_blank" href="https://site-b.test/landing">blank</a>
        <button id="open" onclick="window.open('https://site-b.test/landing')">open</button>
        <button id="noopener" onclick="window.open('https://site-b.test/landing', '_blank', 'noopener')">noopener</button>
        <button id="popup-window" onclick="window.open('https://site-a.test/popup', 'pw', 'popup,width=420,height=320')">popup window</button>
        <button id="opener-closes" onclick="window.open('https://site-a.test/closer')">closer</button>
        <a id="plain" href="https://site-b.test/landing?plain">plain</a>
        <form id="post-form" method="post" action="https://site-b.test/landing?posted"><button id="post">post</button></form>
        <button id="many" onclick="for (let i = 0; i < 12; i++) window.open('https://site-b.test/landing?many=' + i)">many</button>`,
      );
    case '/landing':
      return page(`landing ${site}`, `<p id="landing">${site}</p>`);
    case '/inner-feed':
      // The app layout of the agent workload test (B2, B4): the document does not scroll, an inner
      // feed does; scrolling appends posts and rewrites the URL (replaceState, pushState); a
      // speculation rule prerenders a page a link then activates.
      return page(
        `feed ${site}`,
        `<nav id="nav" style="position:fixed;top:0;left:0;right:0;height:48px;background:#eee">nav</nav>
        <main id="feed" style="position:fixed;top:48px;bottom:0;left:0;right:0;overflow-y:auto">
          <a id="next" href="/landing?prerendered">next</a>
        </main>
        <script>
          const feed = document.getElementById('feed');
          let n = 0;
          const more = () => {
            for (let i = 0; i < 20; i++, n++) {
              const post = document.createElement('article');
              post.style.height = '120px';
              post.textContent = 'post ' + n;
              feed.appendChild(post);
            }
          };
          more();
          feed.addEventListener('scroll', () => {
            if (feed.scrollTop + feed.clientHeight > feed.scrollHeight - 400) more();
            history.replaceState({}, '', '/inner-feed?at=' + Math.round(feed.scrollTop));
            if (n % 40 === 0) history.pushState({}, '', '/inner-feed?page=' + n / 20);
          });
        </script>
        <script type="speculationrules">{"prerender":[{"source":"list","urls":["/landing?prerendered"]}]}</script>`,
        // `?wide`: the document overflows a little sideways and still does not scroll vertically.
        search.includes('wide')
          ? '<style>html,body{margin:0;height:100%}html{overflow-y:hidden}body::after{content:"";display:block;width:110vw;height:1px}</style>'
          : '<style>html,body{margin:0;height:100%;overflow:hidden}</style>',
      );
    case '/popup':
      return page(
        'popup',
        `<button id="tab" onclick="window.open('https://site-b.test/from-popup', '_blank')">tab</button>`,
      );
    case '/from-popup':
      return page('from popup', '<p id="from-popup">tab from a popup window</p>');
    case '/closer':
      // The OAuth shape: open the next page, then close this one at once.
      return page(
        'closer',
        `<button id="go" onclick="window.open('https://idp.test/landing'); window.close()">go</button>`,
      );
    case '/bounce-set': {
      // An SSO cookie bounce (review #85 H1): a 302 hop that sets a sign-in cookie on this site
      // and sends the window on; the hop is never committed as a page.
      const to = new URLSearchParams(search).get('to') ?? '/landing';
      return new Response(null, {
        status: 302,
        headers: {
          location: to,
          'set-cookie': `bounce_sid=${site.replace(/\W/g, '_')}; Path=/; Max-Age=3600; Secure; HttpOnly; SameSite=None`,
        },
      });
    }
    case '/embed-set':
      // A page embedding another site's frame that sets a sign-in-shaped cookie (an ad or widget).
      return page(
        'embed',
        `<iframe id="frame" src="https://cdn-a.test/frame-set"></iframe>
        <button id="popup-set" onclick="window.open('https://site-b.test/bounce-set?to=/landing', 'idp', 'popup,width=420,height=320')">popup</button>`,
      );
    case '/frame-set':
      return new Response('<!doctype html><p id="framed">framed</p>', {
        headers: {
          'content-type': 'text/html',
          'set-cookie': `frame_sid=${site.replace(/\W/g, '_')}; Path=/; Max-Age=3600; Secure; HttpOnly; SameSite=None`,
        },
      });
    case '/set-cookie':
      return new Response('<!doctype html><p id="set">set</p>', {
        headers: {
          'content-type': 'text/html',
          'set-cookie': `shared_${site.replace(/\W/g, '_')}=from-${site}; Path=/; Secure; SameSite=Lax`,
        },
      });
    case '/cache-page':
      // Five cacheable subresources: a routed host serves none from cache (spec 13 §3.8).
      return page(
        'cache',
        [1, 2, 3, 4, 5].map((n) => `<script src="/cached.js?n=${n}"></script>`).join(''),
      );
    case '/cached.js':
      return new Response('window.cachedLoads = (window.cachedLoads || 0) + 1;', {
        headers: { 'content-type': 'text/javascript', 'cache-control': 'public, max-age=3600' },
      });
    case '/cors-page':
      return page('cors', '<p id="cors">cors</p>');
    case '/api/write-allowed':
      // The preflight allows the asking origin, its method and headers (D-66).
      return new Response(method === 'OPTIONS' ? null : 'written', {
        status: method === 'OPTIONS' ? 204 : 200,
        headers: {
          'access-control-allow-origin': 'https://site-a.test',
          'access-control-allow-methods': 'POST',
          'access-control-allow-headers': 'content-type, x-test',
        },
      });
    case '/api/write':
      // The preflight is refused (no Access-Control-Allow-*): a browser that honours it never sends the write.
      if (method === 'OPTIONS') return new Response(null, { status: 403 });
      return new Response('written', { headers: { 'content-type': 'text/plain' } });
    case '/unload-beacon':
      // A beacon from `pagehide` while the page closes: never routed (spec 13 §3.8).
      return page(
        'unload',
        `<p id="unload">unload</p><script>addEventListener('pagehide', () => navigator.sendBeacon('/api/pagehide', 'bye'));</script>`,
      );
    case '/api/pagehide':
      return new Response('ok');
    case '/sw-page':
      return page(
        'sw',
        `<p id="sw">sw</p><script>
          window.swReady = navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready);
        </script>`,
      );
    case '/sw.js':
      return new Response(
        `self.addEventListener('install', () => self.skipWaiting());
         self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
         self.addEventListener('message', (e) => {
           e.waitUntil(self.clients.openWindow('https://site-a.test/landing?from=sw').then(
             (w) => e.source && e.source.postMessage(w ? 'opened' : 'null'),
             (err) => e.source && e.source.postMessage('refused: ' + err.message)));
         });`,
        { headers: { 'content-type': 'text/javascript', 'service-worker-allowed': '/' } },
      );
    default:
      return new Response('not found', { status: 404 });
  }
}

/** Options of {@link startHttpsSites}. */
export interface HttpsSitesOptions {
  /**
   * Also map the challenge providers' hosts (`challenges.cloudflare.com`, `www.google.com`) to the
   * fixture, which serves fake provider frames for them (site pack challenges, spec 13 §9.5).
   */
  readonly providers?: boolean;
}

/** Starts the HTTPS fixture on an ephemeral loopback port. */
export function startHttpsSites(options: HttpsSitesOptions = {}): HttpsSites {
  const requests: { host: string; method: string; path: string; referer: string | null }[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    tls: {
      cert: readFileSync(join(TLS_DIR, 'test.crt'), 'utf8'),
      key: readFileSync(join(TLS_DIR, 'test.key'), 'utf8'),
    },
    async fetch(req) {
      const url = new URL(req.url);
      const host = req.headers.get('host') ?? url.host;
      requests.push({
        host,
        method: req.method,
        path: url.pathname + url.search,
        referer: req.headers.get('referer'),
      });
      const site = host.split(':')[0] ?? host;
      return (
        (await signInRoute(req, site, url.pathname)) ??
        guardRoute(site, url.pathname) ??
        clipboardRoute(site, url.pathname) ??
        route(host, url.pathname, req.method, url.search)
      );
    },
  });
  const port = server.port ?? 0;
  return {
    port,
    url: (host, path = '/') => `https://${host}${path}`,
    chromiumArgs: [
      `--host-resolver-rules=${[
        `MAP *.test:443 127.0.0.1:${port}`,
        ...(options.providers === true
          ? FIXTURE_PROVIDER_HOSTS.map((h) => `MAP ${h}:443 127.0.0.1:${port}`)
          : []),
      ].join(',')}`,
      `--ignore-certificate-errors-spki-list=${FIXTURE_SPKI}`,
    ],
    requests,
    stop: () => server.stop(true),
  };
}

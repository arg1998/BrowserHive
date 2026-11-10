/** @module test/helpers/https-sites — the HTTPS fixture sites of spec 13 §14: `https://site-a.test`, `site-b.test`, `idp.test` and `cdn-a.test` on one TLS listener with the checked-in `*.test` certificate; Chromium reaches them through the testing seam's resolver rule and SPKI pin. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
  /** Requests seen: host, method and path. */
  readonly requests: readonly { host: string; method: string; path: string }[];
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

/** Starts the HTTPS fixture on an ephemeral loopback port. */
export function startHttpsSites(): HttpsSites {
  const requests: { host: string; method: string; path: string }[] = [];
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
      requests.push({ host, method: req.method, path: url.pathname + url.search });
      const site = host.split(':')[0] ?? host;
      return (
        (await signInRoute(req, site, url.pathname)) ??
        route(host, url.pathname, req.method, url.search)
      );
    },
  });
  const port = server.port ?? 0;
  return {
    port,
    url: (host, path = '/') => `https://${host}${path}`,
    chromiumArgs: [
      `--host-resolver-rules=MAP *.test:443 127.0.0.1:${port}`,
      `--ignore-certificate-errors-spki-list=${FIXTURE_SPKI}`,
    ],
    requests,
    stop: () => server.stop(true),
  };
}

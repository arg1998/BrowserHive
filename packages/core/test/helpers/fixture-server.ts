/** @module test/helpers/fixture-server — deterministic pages on 127.0.0.1:0 for integration tests (spec 09 §9). */

const html = (body: string, head = ''): Response =>
  new Response(
    `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`,
    {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    },
  );

const PROBE_SCRIPT = `
  const out = {
    userAgent: navigator.userAgent,
    webdriver: navigator.webdriver,
    languages: [...navigator.languages],
    language: navigator.language,
    platform: navigator.platform,
    deviceMemory: navigator.deviceMemory,
    hardwareConcurrency: navigator.hardwareConcurrency,
    hasChrome: typeof window.chrome !== 'undefined',
    plugins: navigator.plugins.length,
    mimeTypes: navigator.mimeTypes.length,
    pdfViewerEnabled: navigator.pdfViewerEnabled,
    brands: navigator.userAgentData ? navigator.userAgentData.brands : null,
    uaMobile: navigator.userAgentData ? navigator.userAgentData.mobile : null,
    uaPlatform: navigator.userAgentData ? navigator.userAgentData.platform : null,
    screen: { width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight, availTop: screen.availTop, availLeft: screen.availLeft },
    window: { innerWidth, innerHeight, outerWidth, outerHeight, screenX, screenY, screenLeft, screenTop, devicePixelRatio },
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    screenWidthGetterToString: Object.getOwnPropertyDescriptor(Screen.prototype, 'width').get.toString(),
    screenWidthGetterName: Object.getOwnPropertyDescriptor(Screen.prototype, 'width').get.name,
    toStringOfToString: Function.prototype.toString.toString(),
  };
  window.__probe = out;
  document.getElementById('probe').textContent = JSON.stringify(out);
`;

/**
 * An attachment whose first 2 KiB go out at once (enough for Chromium to start the download without
 * waiting to sniff more) and whose remainder is up to `rest`. Bun sends nothing, not even the
 * headers, until `start` settles, so the slow part lives in `pull`.
 */
function attachmentStream(
  filename: string,
  rest: (controller: ReadableStreamDefaultController<Uint8Array>) => Promise<void>,
): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(2048)));
      },
      pull: rest,
    }),
    {
      headers: {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="${filename}"`,
      },
    },
  );
}

/** A running fixture server. */
export interface FixtureServer {
  readonly origin: string;
  readonly port: number;
  /** Requests seen so far (method + path + selected headers), for assertions. */
  readonly requests: readonly { method: string; path: string; headers: Record<string, string> }[];
  url(path: string): string;
  stop(): void;
}

/** Starts the fixture server on an ephemeral port. */
export function startFixtureServer(): FixtureServer {
  const requests: { method: string; path: string; headers: Record<string, string> }[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const headers: Record<string, string> = {};
      for (const key of [
        'user-agent',
        'accept-language',
        'sec-ch-ua',
        'sec-ch-ua-platform',
        'sec-ch-ua-mobile',
        'cookie',
        'x-test',
      ]) {
        const v = req.headers.get(key);
        if (v !== null) headers[key] = v;
      }
      requests.push({ method: req.method, path: url.pathname + url.search, headers });

      switch (url.pathname) {
        case '/':
          return html('<h1 id="title">fixture</h1><a id="form-link" href="/form">form</a>');
        case '/form': {
          const action = url.searchParams.get('action') ?? '/submitted';
          return html(
            `<form id="login" method="post" action="${action}">
              <label for="username">Username</label><input id="username" name="username" autocomplete="username">
              <label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password">
              <button id="submit" type="submit">Sign in</button>
            </form>`,
          );
        }
        case '/form-with-search':
          // A login form under a site search box, plus the fields an agent could misdirect a
          // vault fill into (spec 13 T0e).
          return html(
            `<form id="search-form" role="search" action="/search"><input id="search" type="search" name="q" placeholder="Search"></form>
            <textarea id="notes"></textarea><div id="editor" contenteditable="true"></div>
            <form id="login" method="post" action="/submitted">
              <input id="username" name="username" autocomplete="username">
              <input id="password" name="password" type="password" autocomplete="current-password">
              <input id="hidden-password" name="hidden" type="password" style="display:none">
              <button id="submit" type="submit">Sign in</button>
            </form>`,
          );
        case '/form-delayed':
          // An SPA-style login form, rendered 1 s after load (spec 13 T0e: vault_fill waits for it).
          return html(
            `<div id="app"></div>
            <script>setTimeout(() => {
              document.getElementById('app').innerHTML =
                '<form id="login" method="post" action="/submitted">' +
                '<input id="username" name="username" autocomplete="username">' +
                '<input id="password" name="password" type="password" autocomplete="current-password">' +
                '<button id="submit" type="submit">Sign in</button></form>';
            }, 1000);</script>`,
          );
        case '/submitted': {
          const body = req.method === 'POST' ? await req.text() : '';
          return html(
            `<p id="result">submitted</p><pre id="body">${body.replace(/</g, '&lt;')}</pre>`,
          );
        }
        case '/redirect': {
          const to = url.searchParams.get('to') ?? '/';
          return new Response(null, { status: 302, headers: { location: to } });
        }
        case '/dialog': {
          const kind = url.searchParams.get('kind') ?? 'alert';
          const call =
            kind === 'confirm'
              ? "window.__dialogResult = confirm('fixture confirm')"
              : kind === 'prompt'
                ? "window.__dialogResult = prompt('fixture prompt', 'default')"
                : "alert('fixture alert')";
          return html(`<p id="dialog">${kind}</p><script>${call};</script>`);
        }
        case '/download':
          return new Response('fixture download body\n', {
            headers: {
              'content-type': 'text/plain',
              'content-disposition': 'attachment; filename="fixture.txt"',
            },
          });
        case '/download-page':
          return html(
            '<a id="download" href="/download" download="fixture.txt">download</a>' +
              '<a id="download-broken" href="/download-broken" download>broken download</a>',
          );
        case '/download-broken':
          // The transfer breaks after the first bytes; Chromium marks the download canceled.
          return attachmentStream('broken.bin', async (controller) => {
            await Bun.sleep(100);
            controller.error();
          });
        case '/download-stall': {
          // A transfer that sends its first bytes, then stalls for `ms` (default 10 s).
          const ms = Number(url.searchParams.get('ms') ?? '10000');
          return attachmentStream('stall.bin', async (controller) => {
            await Bun.sleep(ms);
            try {
              controller.close();
            } catch {
              // The client went away (download cancelled, server stopped).
            }
          });
        }
        case '/popup':
          return html(`<button id="open" onclick="window.open('/', '_blank')">open</button>`);
        case '/to-file':
          // A site-initiated navigation to a local file (the URL-scheme backstop suite).
          return html(
            `<p id="to-file">leaving</p><script>window.__tried = true; location = 'file:///etc/hosts';</script>`,
          );
        case '/probe':
          return html(`<pre id="probe"></pre><script>${PROBE_SCRIPT}</script>`);
        case '/slow': {
          const ms = Number(url.searchParams.get('ms') ?? '1000');
          await Bun.sleep(ms);
          return html(`<p id="slow">slept ${ms}</p>`);
        }
        case '/sw.js':
          return new Response("self.addEventListener('fetch', () => {});", {
            headers: { 'content-type': 'application/javascript' },
          });
        case '/sw':
          return html(
            `<p id="sw">sw</p><script>navigator.serviceWorker.register('/sw.js').then(() => { window.__swReady = true; });</script>`,
          );
        case '/storage':
          return html(
            `<p id="storage"></p><script>
              const key = 'bh-fixture';
              document.getElementById('storage').textContent = JSON.stringify({ local: localStorage.getItem(key), session: sessionStorage.getItem(key), cookie: document.cookie });
              window.__setStorage = (v) => { localStorage.setItem(key, v); sessionStorage.setItem(key, v); document.cookie = key + '=' + v + '; path=/'; };
            </script>`,
          );
        case '/set-cookie': {
          // `max_age` makes it a persistent cookie (written to the profile's cookie database).
          const maxAge = url.searchParams.get('max_age');
          const name = url.searchParams.get('name') ?? 'fixture';
          return new Response('ok', {
            headers: {
              'set-cookie': `${name}=${url.searchParams.get('v') ?? '1'}; Path=/${maxAge === null ? '' : `; Max-Age=${maxAge}`}`,
            },
          });
        }
        case '/status': {
          const code = Number(url.searchParams.get('code') ?? '200');
          return html(`<p id="status">${code}</p>`).status === 200
            ? new Response(`<!doctype html><p id="status">${code}</p>`, {
                status: code,
                headers: { 'content-type': 'text/html' },
              })
            : new Response(null, { status: code });
        }
        case '/echo-headers':
          return new Response(JSON.stringify(headers), {
            headers: { 'content-type': 'application/json' },
          });
        case '/elements':
          return html(
            `<h1 id="h">Elements</h1>
             <button id="btn" onclick="this.textContent='clicked'">click me</button>
             <input id="text" placeholder="type here">
             <select id="sel"><option value="a">A</option><option value="b">B</option></select>
             <input id="chk" type="checkbox">
             <div id="hover" onmouseover="this.textContent='hovered'">hover me</div>
             <div id="drag" draggable="true">drag</div><div id="drop">drop</div>
             <input id="file" type="file">
             <div id="tall" style="height:3000px"></div><p id="bottom">bottom</p>`,
          );
        case '/logout':
          // GitHub's shape (issue #59): a GET shows a confirm form, the sign-out is its POST.
          return req.method === 'POST'
            ? html('<p id="signed-out">signed out</p>')
            : html(
                `<form id="logout" method="post" action="/logout"><button id="sign-out" type="submit">Sign out</button></form>
                <form id="search" method="get" action="/logout"><button id="search-go" type="submit">Search</button></form>`,
              );
        case '/cached':
          // Fresh for an hour: a second `force-cache` fetch is served from the HTTP cache when
          // the context has one (routing disables it).
          return new Response('cached', {
            headers: { 'content-type': 'text/plain', 'cache-control': 'public, max-age=3600' },
          });
        case '/shared-worker.js':
          // A SharedWorker that POSTs once per connection (spec 13 §3.8: never routed).
          return new Response(
            "onconnect = (e) => { const port = e.ports[0]; fetch('/api/shared-worker', { method: 'POST', body: 'x' }).then((r) => port.postMessage('ok:' + r.status), (x) => port.postMessage('err:' + x.name)); };",
            { headers: { 'content-type': 'application/javascript' } },
          );
        case '/worker.js':
          // A dedicated worker that POSTs once (routed like the page's own requests).
          return new Response(
            "fetch('/api/worker', { method: 'POST', body: 'x' }).then((r) => postMessage('ok:' + r.status), (x) => postMessage('err:' + x.name));",
            { headers: { 'content-type': 'application/javascript' } },
          );
        case '/unload-beacon':
          // Sends a beacon from `pagehide` (spec 13 §3.8: not routed when the page is closed).
          return html(
            `<p id="unload">unload</p><script>addEventListener('pagehide', () => navigator.sendBeacon('/api/pagehide', 'bye'));</script>`,
          );
        default:
          if (url.pathname.startsWith('/cors/')) {
            // A cross-origin endpoint whose preflight refuses: an unrouted browser never sends
            // the write itself.
            if (req.method === 'OPTIONS') return new Response('no', { status: 403 });
            return new Response('cors write reached');
          }
          if (url.pathname.startsWith('/api/')) {
            // Any method: what a page's fetch, XHR or beacon reached.
            return new Response(JSON.stringify({ method: req.method, path: url.pathname }), {
              headers: { 'content-type': 'application/json' },
            });
          }
          return new Response('not found', { status: 404 });
      }
    },
  });
  const port = server.port ?? 0;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    port,
    requests,
    url: (path: string) => `${origin}${path}`,
    stop: () => {
      server.stop(true);
    },
  };
}

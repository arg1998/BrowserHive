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
          return html('<a id="download" href="/download" download="fixture.txt">download</a>');
        case '/popup':
          return html(`<button id="open" onclick="window.open('/', '_blank')">open</button>`);
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
        case '/set-cookie':
          return new Response('ok', {
            headers: { 'set-cookie': `fixture=${url.searchParams.get('v') ?? '1'}; Path=/` },
          });
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
        default:
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

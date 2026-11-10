/** @module test/helpers/https-sites-signin — the sign-in and sealing pages of the HTTPS fixture sites (spec 13 §7.1, §14): a password form that sets a persistent `HttpOnly` `Secure` session cookie (plus an analytics cookie), an account page that says who is signed in, a page that embeds a cookie value in its HTML, and a download. */

/** The value of the sealing sentinel cookie (also embedded in the `/sealed` page's HTML). */
export const SENTINEL_COOKIE_VALUE = 'sentinel-cookie-7f3a9c2e5b1d';
/** The localStorage and IndexedDB sentinels the `/sealed` page stores. */
export const SENTINEL_STORAGE_VALUE = 'sentinel-storage-4e8b2a6c0f9d';

const html = (title: string, body: string, headers: Record<string, string> = {}): Response =>
  new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`,
    { headers: { 'content-type': 'text/html; charset=utf-8', ...headers } },
  );

function cookieOf(req: Request, name: string): string | null {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return null;
}

/** The site whose home page is its sign-in form (the end-to-end journey types into it by hand). */
export const FORM_HOME_SITE = 'shop.test';

/** The sign-in pages, or `null` for any other path. */
export async function signInRoute(
  req: Request,
  site: string,
  path: string,
): Promise<Response | null> {
  const formHome = site === FORM_HOME_SITE && path === '/' && req.method === 'GET';
  if ((path === '/login' && req.method === 'GET') || formHome) {
    return html(
      `Sign in to ${site}`,
      `<form method="post" action="/login">
        <input id="username" name="username" autocomplete="username" autofocus>
        <input id="password" name="password" type="password" autocomplete="current-password">
        <button id="submit" type="submit">Sign in</button>
      </form>
      <script>
        // Keystrokes typed into the window land in the form even before a field has the focus.
        const user = document.getElementById('username');
        user.focus();
        addEventListener('focus', () => { if (document.activeElement === document.body) user.focus(); });
        addEventListener('keydown', () => { if (document.activeElement === document.body) user.focus(); }, true);
      </script>`,
    );
  }
  if (path === '/login' && req.method === 'POST') {
    const form = await req.formData();
    const user = String(form.get('username') ?? 'someone');
    const sid = `sid-${site}-${crypto.randomUUID()}`;
    const response = html('Signed in', `<p id="signed-in">Signed in as ${user}</p>`);
    response.headers.append(
      'set-cookie',
      `sid=${sid}; Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=Lax`,
    );
    response.headers.append('set-cookie', `_ga=GA1.1.${Date.now()}; Path=/; Max-Age=86400; Secure`);
    response.headers.append(
      'set-cookie',
      `user=${encodeURIComponent(user)}; Path=/; Max-Age=86400; Secure`,
    );
    return response;
  }
  if (path === '/account') {
    const user = cookieOf(req, 'user');
    const signedIn = cookieOf(req, 'sid') !== null;
    return html(
      'Account',
      signedIn
        ? `<p id="account">Signed in to ${site} as ${decodeURIComponent(user ?? '')}</p>`
        : `<p id="account">Not signed in to ${site}</p>`,
    );
  }
  if (path === '/sealed') {
    return html(
      'sealed',
      `<p id="token">token ${SENTINEL_COOKIE_VALUE}</p>
       <script>
         // Built at run time: the storage sentinel is never in the page's source.
         const value = ${JSON.stringify(SENTINEL_STORAGE_VALUE.split('-'))}.join('-');
         localStorage.setItem('bh_ls', value);
         const open = indexedDB.open('bh_db', 1);
         open.onupgradeneeded = () => open.result.createObjectStore('s');
         open.onsuccess = () => open.result.transaction('s', 'readwrite').objectStore('s').put(value, 'k');
       </script>`,
      {
        'set-cookie': `bh_sentinel=${SENTINEL_COOKIE_VALUE}; Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=Lax`,
      },
    );
  }
  if (path === '/stall') {
    // The sequence that stalled a minimized window's rendering (spec 13 §3.10): popup, dialog, download.
    return html(
      'stall',
      `<button id="popup" onclick="window.open('/landing', 'p', 'popup,width=300,height=200')">popup</button>
       <button id="dialog" onclick="alert('hello')">dialog</button>
       <a id="download" href="/download" download>download</a>`,
    );
  }
  if (path === '/download') {
    return new Response('file body', {
      headers: {
        'content-type': 'application/octet-stream',
        'content-disposition': 'attachment; filename="report.txt"',
      },
    });
  }
  return null;
}

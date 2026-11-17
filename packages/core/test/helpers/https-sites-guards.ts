/** @module test/helpers/https-sites-guards — the guard pages of the HTTPS fixture sites (spec 13 §14, T3a): a LinkedIn-shaped feed whose controls sign out by form `POST`, `fetch` and `sendBeacon`, a write endpoint, the logout endpoint (any method) and an open redirect into it. */

const html = (title: string, body: string): Response =>
  new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`,
    { headers: { 'content-type': 'text/html; charset=utf-8' } },
  );

/** The guard pages, or `null` for any other path. */
export function guardRoute(site: string, path: string): Response | null {
  switch (path) {
    case '/feed':
      return html(
        `feed ${site}`,
        `<h1 id="feed">${site}</h1>
        <form id="logout-form" method="post" action="/m/logout"><button id="logout-post">Sign out</button></form>
        <button id="logout-fetch" onclick="window.out = fetch('/m/logout', {method: 'POST'}).then(() => 'sent', () => 'blocked')">fetch out</button>
        <button id="logout-beacon" onclick="window.beacon = navigator.sendBeacon('/m/logout', 'bye')">beacon out</button>
        <button id="invite" onclick="window.invite = fetch('/api/invite', {method: 'POST', body: 'x'}).then((r) => 'status ' + r.status, () => 'blocked')">invite</button>
        <button id="invite-twice" onclick="window.first = fetch('/api/invite?n=1', {method: 'POST'}).then(() => 'sent', () => 'blocked'); window.second = fetch('/api/invite?n=2', {method: 'POST'}).then(() => 'sent', () => 'blocked')">invite twice</button>`,
      );
    case '/m/logout':
      return html('signed out', '<p id="signed-out">signed out</p>');
    case '/api/invite':
      return new Response('invited', { headers: { 'content-type': 'text/plain' } });
    case '/go':
      // A same-site redirect into the logout (spec 13 §3.8: the route never sees the hop).
      return new Response(null, { status: 302, headers: { location: '/m/logout' } });
    default:
      return null;
  }
}

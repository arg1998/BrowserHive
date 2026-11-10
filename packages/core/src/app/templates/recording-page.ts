/** @module app/templates/recording-page — the first tab of a recording window (spec 13 §3.3, §7): the `[BrowserHive] Sign in to <site>` marker in the window title and the operator's instructions. A local document; it loads nothing. */

/** The marker every recording window carries in its title (spec 13 §3.3). */
export const RECORDING_TITLE_PREFIX = '[BrowserHive] Sign in to';

/** Escapes text for HTML. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** The window title of a recording for `sites`. */
export function recordingTitle(sites: readonly string[]): string {
  return `${RECORDING_TITLE_PREFIX} ${sites.join(', ')}`;
}

/** The instructions page (HTML) of a recording for `sites`. */
export function recordingPage(sites: readonly string[]): string {
  const title = escapeHtml(recordingTitle(sites));
  const items = sites.map((site) => `<li><b>${escapeHtml(site)}</b></li>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;color:#1f2328}
h1{font-size:1.4rem}li{margin:.25rem 0}.note{color:#57606a}</style></head>
<body><h1>${title}</h1>
<p>BrowserHive opened this window so you can sign in. Each site has its own tab in this window:</p>
<ul>${items}</ul>
<p>Type your user names and passwords rather than pasting them, and check the address bar before you type.
Saved passwords and password-manager extensions are not available in this browser.</p>
<p>When you are signed in to every site, go back to the terminal (press Enter) or to the dashboard.</p>
<p class="note">Agents that use this template will start signed in to these sites. Anything else you sign in to here is listed when you finish, so you can remove it.</p>
</body></html>`;
}

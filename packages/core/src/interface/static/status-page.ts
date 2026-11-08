/** @module interface/static/status-page — the minimal server-rendered page shown when `admin=false`: at `/`, and with a 404 for a browser navigation to any other dashboard path (spec 03 §8, D-59). */

/** Facts shown on the status page. */
export interface StatusPageFacts {
  readonly version: string;
  readonly transport: string;
  readonly mcpUrl: string;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * Light and dark styles from the dashboard tokens (`styles/tokens.css`), switched by
 * `prefers-color-scheme`. Inline, which the CSP's `style-src 'unsafe-inline'` allows; no script.
 */
const STATUS_PAGE_STYLE = [
  ':root{color-scheme:light dark;--bg:oklch(0.985 0.002 250);--fg:oklch(0.2 0.012 250);--muted:oklch(0.5 0.012 250);--border:oklch(0.92 0.004 250);--code:oklch(0.965 0.003 250)}',
  '@media (prefers-color-scheme:dark){:root{--bg:oklch(0.155 0.004 250);--fg:oklch(0.95 0.003 250);--muted:oklch(0.7 0.008 250);--border:oklch(1 0 0 / 0.08);--code:oklch(1 0 0 / 0.05)}}',
  'body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}',
  'main{max-width:36rem;margin:0 auto;padding:3rem 1rem}',
  'h1{font-size:1.25rem;margin:0 0 1rem}',
  'dl{display:grid;grid-template-columns:max-content 1fr;gap:.25rem 1rem;margin:1.5rem 0 0;padding-top:1rem;border-top:1px solid var(--border)}',
  'dt{color:var(--muted)}dd{margin:0;min-width:0;overflow-wrap:anywhere}',
  'code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--code);padding:.1rem .3rem;border-radius:4px}',
].join('');

/** Renders the status page. */
export function statusPageHtml(facts: StatusPageFacts): string {
  const v = escapeHtml(facts.version);
  const t = escapeHtml(facts.transport);
  const u = escapeHtml(facts.mcpUrl);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>BrowserHive ${v}</title><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><style>${STATUS_PAGE_STYLE}</style></head><body><main><h1>BrowserHive ${v}</h1><p>The dashboard is turned off. Restart BrowserHive with <code>--admin</code> to use it.</p><dl><dt>Version</dt><dd>${v}</dd><dt>Transport</dt><dd>${t}</dd><dt>MCP endpoint</dt><dd><code>${u}</code></dd></dl></main></body></html>`;
}

/** True when an `Accept` header lists `text/html` with a non-zero quality. */
function acceptsHtml(accept: string): boolean {
  return accept.split(',').some((range) => {
    const [type = '', ...params] = range.split(';').map((part) => part.trim().toLowerCase());
    if (type !== 'text/html') return false;
    const q = params.find((param) => param.startsWith('q='));
    return q === undefined || Number(q.slice(2)) > 0;
  });
}

/**
 * True for a browser navigation: a `GET`/`HEAD` with `Sec-Fetch-Mode: navigate`, or
 * `Sec-Fetch-Dest: document`, or, when neither of those headers is present (an older browser or a
 * plain client), an `Accept` that lists `text/html` (spec 03 §8). The dashboard's service worker
 * forwards navigations untouched, so they keep `Sec-Fetch-Mode: navigate` (04 §18.5.4).
 */
export function isBrowserNavigation(request: Request): boolean {
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return false;
  const mode = request.headers.get('sec-fetch-mode');
  const dest = request.headers.get('sec-fetch-dest');
  if (mode !== null || dest !== null) {
    return mode?.toLowerCase() === 'navigate' || dest?.toLowerCase() === 'document';
  }
  return acceptsHtml(request.headers.get('accept') ?? '');
}

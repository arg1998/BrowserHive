/** @module interface/static/status-page — the minimal server-rendered page at `/` when `admin=false` (spec 03 §8). */

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

/** Renders the status page. */
export function statusPageHtml(facts: StatusPageFacts): string {
  const v = escapeHtml(facts.version);
  const t = escapeHtml(facts.transport);
  const u = escapeHtml(facts.mcpUrl);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>BrowserHive ${v}</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><h1>BrowserHive ${v}</h1><p>Transport: ${t}</p><p>MCP endpoint: <code>${u}</code></p><p>The dashboard is disabled. Start the server with <code>--admin</code> to enable it.</p></body></html>`;
}

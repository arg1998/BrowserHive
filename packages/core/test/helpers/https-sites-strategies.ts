/** @module test/helpers/https-sites-strategies — the before-action strategy pages of the HTTPS fixture sites (spec 13 §9.4, §14): an input page that records pointer moves and key timings in the DOM (humanized input), warm-up entries that leave the pack's domains by a server redirect and by a script navigation (the fail-closed guard), and a page whose body arrives late (a long-running action). */

/** How long `/strategy/slow` waits before answering. */
export const STRATEGY_SLOW_MS = 4_000;

const html = (title: string, body: string): Response =>
  new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`,
    { headers: { 'content-type': 'text/html; charset=utf-8' } },
  );

/** The strategy pages, or `null` for any other path. */
export function strategyRoute(path: string): Response | null {
  switch (path) {
    case '/strategy/input':
      // Pointer moves and key intervals land in data attributes (readable without page scripts).
      return html(
        'input',
        `<input id="field"><button id="btn" style="margin:200px">go</button>
        <script>
          let moves = 0; let last = 0; const gaps = [];
          addEventListener('mousemove', (e) => { if (e.isTrusted) document.body.dataset.moves = String(++moves); });
          addEventListener('keydown', () => { const now = performance.now(); if (last) gaps.push(Math.round(now - last)); last = now; document.body.dataset.gaps = gaps.join(','); });
        </script>`,
      );
    case '/strategy/leave':
      // A server redirect: the driver routes only the first URL of a chain (spec 13 §3.8).
      return new Response(null, {
        status: 302,
        headers: { location: 'https://site-b.test/landing?from=warmup-302' },
      });
    case '/strategy/leave-js':
      return html(
        'leaving',
        `<script>location.href = 'https://site-b.test/landing?from=warmup-js';</script>`,
      );
    case '/strategy/slow': {
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          await Bun.sleep(STRATEGY_SLOW_MS);
          controller.enqueue(
            new TextEncoder().encode('<!doctype html><title>slow</title><p>slow</p>'),
          );
          controller.close();
        },
      });
      return new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    default:
      return null;
  }
}

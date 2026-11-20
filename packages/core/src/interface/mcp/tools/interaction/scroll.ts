/** @module interface/mcp/tools/interaction/scroll — what `scroll` moves (workload test B4): the document when it scrolls, else the page's main scroll container (an app layout whose `body` does not scroll and whose feed is an inner element), found in the page and reported with the position it reached. */

/** What the in-page script does: scroll (`by`/`to`) and report, or only report (`read`). */
export interface ScrollScriptArgs {
  readonly mode: 'by' | 'to' | 'read';
  readonly dx: number;
  readonly dy: number;
  readonly x: number;
  readonly y: number;
  readonly behavior: 'auto' | 'smooth';
}

/** What the script reports: the position of what scrolls, and what that is. */
export interface ScrollScriptResult {
  readonly x: number;
  readonly y: number;
  readonly target: 'window' | 'element';
  /** A short description of the element (`main#feed`, `div.scaffold-layout__main`). */
  readonly element?: string;
  /** Where to point the wheel so it reaches the element (its visible centre). */
  readonly point?: { readonly x: number; readonly y: number };
}

/**
 * Runs in the page (self-contained: serialized into an expression). Picks what scrolls: the
 * document when it can scroll on the requested axis; otherwise the nearest scrollable ancestor of
 * the element at the viewport's centre, else the scrollable element with the largest visible area,
 * else the document. Then scrolls it (`by`, `to`), waits for a smooth scroll to settle (≤ 1 s) and
 * reports its offset. Reads only; marks nothing in the page.
 */
export async function scrollInPage(args: ScrollScriptArgs): Promise<ScrollScriptResult> {
  const doc = document.scrollingElement ?? document.documentElement;
  const scrolls = (overflow: string): boolean =>
    overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay';
  // The axes the call moves: for `to`, those whose target differs from the document's offset, so
  // a few pixels of horizontal overflow never make the document the target of a vertical move
  // (review #88 L2).
  const moved: ('x' | 'y')[] =
    args.mode === 'to'
      ? [
          ...(args.y !== scrollY ? (['y'] as const) : []),
          ...(args.x !== scrollX ? (['x'] as const) : []),
        ]
      : args.dy !== 0
        ? ['y']
        : args.dx !== 0
          ? ['x']
          : [];
  const axes: ('x' | 'y')[] = moved.length > 0 ? moved : ['y'];
  const documentScrolls = (axis: 'x' | 'y'): boolean => {
    const prop = axis === 'y' ? 'overflowY' : 'overflowX';
    let overflow = getComputedStyle(document.documentElement)[prop];
    if (overflow === 'visible' && document.body !== null) {
      overflow = getComputedStyle(document.body)[prop];
    }
    if (overflow === 'hidden' || overflow === 'clip') return false;
    return axis === 'y'
      ? doc.scrollHeight - doc.clientHeight > 1
      : doc.scrollWidth - doc.clientWidth > 1;
  };
  const elementScrolls = (el: Element, axis: 'x' | 'y'): boolean => {
    const style = getComputedStyle(el);
    return axis === 'y'
      ? scrolls(style.overflowY) && el.scrollHeight - el.clientHeight > 1
      : scrolls(style.overflowX) && el.scrollWidth - el.clientWidth > 1;
  };
  const parentOf = (el: Element): Element | null => {
    if (el.parentElement !== null) return el.parentElement;
    const root = el.getRootNode();
    return root instanceof ShadowRoot ? root.host : null;
  };
  let target: Element | null = null;
  if (!axes.some(documentScrolls)) {
    const centre = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    for (let el = centre; el !== null && el !== document.documentElement; el = parentOf(el)) {
      if (axes.some((axis) => elementScrolls(el as Element, axis))) {
        target = el;
        break;
      }
    }
    if (target === null) {
      let best = 0;
      const all = document.querySelectorAll('*');
      for (let i = 0; i < all.length && i < 20_000; i++) {
        const el = all[i];
        if (el === undefined || !axes.some((axis) => elementScrolls(el, axis))) continue;
        const r = el.getBoundingClientRect();
        const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
        const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
        if (w * h > best) {
          best = w * h;
          target = el;
        }
      }
    }
  }
  const read = (): { x: number; y: number } =>
    target === null ? { x: scrollX, y: scrollY } : { x: target.scrollLeft, y: target.scrollTop };
  const scroller: { scrollBy: Window['scrollBy']; scrollTo: Window['scrollTo'] } = target ?? window;
  if (args.mode === 'by') {
    scroller.scrollBy({ left: args.dx, top: args.dy, behavior: args.behavior });
  } else if (args.mode === 'to') {
    scroller.scrollTo({ left: args.x, top: args.y, behavior: args.behavior });
  }
  if (args.mode !== 'read' && args.behavior === 'smooth') {
    // A smooth scroll moves over several frames: report where it settles (≤ 1 s).
    let last = read();
    for (let waited = 0; waited < 1_000; waited += 50) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const now = read();
      if (now.x === last.x && now.y === last.y && waited >= 100) break;
      last = now;
    }
  }
  const position = read();
  if (target === null) return { ...position, target: 'window' };
  const id = target.id === '' ? '' : `#${target.id}`;
  const cls =
    id === '' && typeof target.className === 'string' && target.className.trim() !== ''
      ? `.${target.className.trim().split(/\s+/)[0]}`
      : '';
  const r = target.getBoundingClientRect();
  const left = Math.max(r.left, 0);
  const top = Math.max(r.top, 0);
  const right = Math.min(r.right, innerWidth);
  const bottom = Math.min(r.bottom, innerHeight);
  return {
    ...position,
    target: 'element',
    element: `${target.tagName.toLowerCase()}${id}${cls}`.slice(0, 80),
    point: { x: Math.round((left + right) / 2), y: Math.round((top + bottom) / 2) },
  };
}

/** The expression that runs {@link scrollInPage} with `args` (page actions take an expression). */
export function scrollExpression(args: ScrollScriptArgs): string {
  return `(${scrollInPage.toString()})(${JSON.stringify(args)})`;
}

/** @module offline/icons — the brand mark and the few line icons the offline page draws with `createElementNS`, so it needs no icon request (04 §18.6). The line icons are Lucide's (ISC), 24×24, stroke 2. */
import { svg } from './dom.ts';

let gradientCount = 0;

/** The hive mark, the same drawing as `components/shared/brand-mark.tsx`; decorative. */
export function brandMark(doc: Document, className: string): SVGElement {
  gradientCount += 1;
  const id = `bh-mark-${gradientCount}`;
  const mark = svg(doc, 'svg', { viewBox: '0 0 32 32', class: className, 'aria-hidden': 'true' }, [
    svg(doc, 'defs', {}, [
      svg(doc, 'linearGradient', { id, x1: '0', y1: '0', x2: '1', y2: '1' }, [
        svg(doc, 'stop', { offset: '0', style: 'stop-color: var(--brand-from)' }),
        svg(doc, 'stop', { offset: '1', style: 'stop-color: var(--brand-to)' }),
      ]),
    ]),
    svg(doc, 'path', {
      d: 'M16 3L27.26 9.5L27.26 22.5L16 29L4.74 22.5L4.74 9.5Z',
      fill: `url(#${id})`,
      stroke: `url(#${id})`,
      'stroke-width': '3',
      'stroke-linejoin': 'round',
    }),
    svg(doc, 'g', { fill: 'white', transform: 'translate(0 1.1)' }, [
      svg(doc, 'path', { d: 'M16 7.71L19.38 9.66L19.38 13.56L16 15.51L12.62 13.56L12.62 9.66Z' }),
      svg(doc, 'path', {
        d: 'M12.2 14.29L15.58 16.24L15.58 20.14L12.2 22.09L8.82 20.14L8.82 16.24Z',
        'fill-opacity': '0.72',
      }),
      svg(doc, 'path', {
        d: 'M19.8 14.29L23.18 16.24L23.18 20.14L19.8 22.09L16.42 20.14L16.42 16.24Z',
        'fill-opacity': '0.72',
      }),
    ]),
  ]);
  return mark;
}

/** The line icons in use. */
export type IconName = 'copy' | 'check' | 'retry' | 'external';

const SHAPES: Record<IconName, readonly (readonly [string, Record<string, string>])[]> = {
  copy: [
    ['rect', { width: '14', height: '14', x: '8', y: '8', rx: '2', ry: '2' }],
    ['path', { d: 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2' }],
  ],
  check: [['path', { d: 'M20 6 9 17l-5-5' }]],
  retry: [
    ['path', { d: 'M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8' }],
    ['path', { d: 'M21 3v5h-5' }],
  ],
  external: [
    ['path', { d: 'M7 7h10v10' }],
    ['path', { d: 'M7 17 17 7' }],
  ],
};

/** A decorative line icon. */
export function icon(doc: Document, name: IconName, className: string): SVGElement {
  return svg(
    doc,
    'svg',
    {
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '2',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      class: className,
      'aria-hidden': 'true',
    },
    SHAPES[name].map(([tag, attrs]) => svg(doc, tag, attrs)),
  );
}

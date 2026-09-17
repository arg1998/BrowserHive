/** @module website/lib/og-image — renders 1200×630 social preview PNGs at build time with satori and resvg. */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Resvg } from '@resvg/resvg-js';
import satori from 'satori';
import { OG_HEIGHT, OG_WIDTH } from './og.ts';

const require = createRequire(import.meta.url);
const font = (pkg: string, file: string) => readFileSync(require.resolve(`${pkg}/files/${file}`));

const FONTS = [
  {
    name: 'Geist',
    data: font('@fontsource/geist', 'geist-latin-400-normal.woff'),
    weight: 400 as const,
    style: 'normal' as const,
  },
  {
    name: 'Geist',
    data: font('@fontsource/geist', 'geist-latin-600-normal.woff'),
    weight: 600 as const,
    style: 'normal' as const,
  },
  {
    name: 'Geist',
    data: font('@fontsource/geist', 'geist-latin-700-normal.woff'),
    weight: 700 as const,
    style: 'normal' as const,
  },
  {
    name: 'JetBrains Mono',
    data: font('@fontsource/jetbrains-mono', 'jetbrains-mono-latin-500-normal.woff'),
    weight: 500 as const,
    style: 'normal' as const,
  },
];

const C = {
  bg: '#07090d',
  panel: '#0e131d',
  line: 'rgba(148,170,210,0.16)',
  text: '#eef2f8',
  muted: '#97a1b4',
  dim: '#626c7e',
  blue: '#5b95f5',
  honey: '#ffb224',
  honeyText: '#ffc55c',
};

type Style = Record<string, string | number>;
interface Node {
  type: string;
  props: {
    style?: Style;
    children?: Child | Child[];
    src?: string;
    width?: number;
    height?: number;
  };
}
type Child = Node | string;

const h = (type: string, style: Style, children?: Child | Child[]): Node => ({
  type,
  props: { style, children },
});
const img = (src: string, width: number, height: number, style: Style = {}): Node => ({
  type: 'img',
  props: { src, width, height, style },
});
const svg = (markup: string) =>
  `data:image/svg+xml;base64,${Buffer.from(markup).toString('base64')}`;

const LOGO = svg(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5b95f5"/><stop offset="1" stop-color="#2459c9"/></linearGradient></defs><path d="M16 3L27.26 9.5L27.26 22.5L16 29L4.74 22.5L4.74 9.5Z" fill="url(#g)" stroke="url(#g)" stroke-width="3" stroke-linejoin="round"/><g fill="#fff" transform="translate(0 1.1)"><path d="M16 7.71L19.38 9.66L19.38 13.56L16 15.51L12.62 13.56L12.62 9.66Z" fill="#ffc34d"/><path d="M12.2 14.29L15.58 16.24L15.58 20.14L12.2 22.09L8.82 20.14L8.82 16.24Z" fill-opacity=".78"/><path d="M19.8 14.29L23.18 16.24L23.18 20.14L19.8 22.09L16.42 20.14L16.42 16.24Z" fill-opacity=".78"/></g></svg>`,
);

/** A honeycomb that fades out toward the left, drawn as one SVG so satori does not lay out hundreds of nodes. */
const HIVE = (() => {
  const r = 34;
  const w = Math.sqrt(3) * r;
  const cells: string[] = [];
  for (let row = -1; row < 12; row++) {
    for (let col = -1; col < 16; col++) {
      const cx = col * w + (row % 2 ? w / 2 : 0) + 420;
      const cy = row * r * 1.5;
      const fade = Math.max(0, Math.min(1, (cx - 380) / 700)) * Math.max(0, 1 - cy / 700);
      if (fade <= 0.02) continue;
      const pts = Array.from({ length: 6 }, (_, i) => {
        const a = (Math.PI / 3) * i + Math.PI / 6;
        return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`;
      }).join(' ');
      cells.push(
        `<polygon points="${pts}" fill="none" stroke="#94aad2" stroke-opacity="${(0.13 * fade).toFixed(3)}" stroke-width="1.2"/>`,
      );
    }
  }
  // A few filled cells near the top right, like sessions lighting up.
  const lit: [number, number, string, number][] = [
    [1097.6, 255, '#ffb224', 0.6],
    [1126.7, 306, '#5b95f5', 0.45],
    [1156.5, 357, '#5b95f5', 0.25],
  ];
  for (const [cx, cy, color, op] of lit) {
    const pts = Array.from({ length: 6 }, (_, i) => {
      const a = (Math.PI / 3) * i + Math.PI / 6;
      return `${(cx + (r - 3) * Math.cos(a)).toFixed(1)},${(cy + (r - 3) * Math.sin(a)).toFixed(1)}`;
    }).join(' ');
    cells.push(
      `<polygon points="${pts}" fill="${color}" fill-opacity="${op * 0.35}" stroke="${color}" stroke-opacity="${op}" stroke-width="1.5"/>`,
    );
  }
  // Glows live in the SVG: resvg draws SVG radial gradients smoothly, satori's CSS ones come out banded.
  const glows = `<defs><radialGradient id="b" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#3b7af0" stop-opacity="0.34"/><stop offset="1" stop-color="#3b7af0" stop-opacity="0"/></radialGradient><radialGradient id="h" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#ffb224" stop-opacity="0.12"/><stop offset="1" stop-color="#ffb224" stop-opacity="0"/></radialGradient></defs><ellipse cx="960" cy="60" rx="520" ry="380" fill="url(#b)"/><ellipse cx="520" cy="690" rx="420" ry="240" fill="url(#h)"/>`;
  return svg(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_WIDTH}" height="${OG_HEIGHT}">${glows}${cells.join('')}</svg>`,
  );
})();

/** The bundled Latin subsets have no math symbols; spell them out instead of drawing empty boxes. */
const ASCII_FALLBACK: Record<string, string> = {
  '≥': '>=',
  '≤': '<=',
  '→': '->',
  '←': '<-',
  '≠': '!=',
};

function clamp(text: string, max: number): string {
  const truncated = /…$/.test(text.trim());
  const t = text
    .replace(/[≥≤→←≠]/g, (ch) => ASCII_FALLBACK[ch] ?? ch)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/…$/, '');
  if (t.length <= max) return truncated ? `${t.replace(/[\s,.;:]+$/, '')}…` : t;
  return `${t.slice(0, max).replace(/[\s,.;:]+\S*$/, '')}…`;
}

export interface OgCard {
  /** Mono label above the title, e.g. `Guides`. */
  eyebrow: string;
  title: string;
  /** Title words to paint honey. */
  highlight?: string;
  description?: string;
  /** Right side of the header, e.g. `docs · v0`. */
  badge: string;
  /** Footer path, e.g. `browserhive.ai/docs/guide/vault`. */
  url: string;
  /** Footer right side, e.g. a command. */
  footnote?: string;
}

/** One span per word, because satori drops spaces at the edges of adjacent text nodes. */
function titleNodes(title: string, highlight: string | undefined): Child[] {
  const words = title.split(' ');
  return words.map((word, i) => {
    const bare = word.replace(/[.,:;!?]+$/, '');
    const style: Style = { display: 'flex', marginRight: i < words.length - 1 ? '0.26em' : 0 };
    if (highlight && bare === highlight) {
      return h('span', style, [h('span', { color: C.honey }, bare), word.slice(bare.length)]);
    }
    return h('span', style, word);
  });
}

function card(c: OgCard): Node {
  const titleSize = c.title.length > 48 ? 56 : c.title.length > 20 ? 66 : 80;
  return h(
    'div',
    {
      width: OG_WIDTH,
      height: OG_HEIGHT,
      display: 'flex',
      position: 'relative',
      backgroundColor: C.bg,
      fontFamily: 'Geist',
      color: C.text,
    },
    [
      img(HIVE, OG_WIDTH, OG_HEIGHT, { position: 'absolute', top: 0, left: 0 }),
      h('div', {
        position: 'absolute',
        top: 0,
        left: 0,
        width: OG_WIDTH,
        height: 4,
        display: 'flex',
        backgroundImage: `linear-gradient(90deg, ${C.blue}, ${C.honey})`,
      }),
      h(
        'div',
        {
          display: 'flex',
          flexDirection: 'column',
          width: '100%',
          height: '100%',
          padding: '64px 72px 56px',
        },
        [
          h('div', { display: 'flex', alignItems: 'center', justifyContent: 'space-between' }, [
            h('div', { display: 'flex', alignItems: 'center' }, [
              img(LOGO, 52, 52),
              h(
                'span',
                { marginLeft: 16, fontSize: 34, fontWeight: 700, letterSpacing: -0.8 },
                'BrowserHive',
              ),
            ]),
            h(
              'div',
              {
                display: 'flex',
                padding: '8px 18px',
                borderRadius: 999,
                border: `1.5px solid ${C.line}`,
                backgroundColor: 'rgba(14,19,29,0.8)',
                fontFamily: 'JetBrains Mono',
                fontSize: 20,
                color: C.muted,
              },
              c.badge,
            ),
          ]),
          h(
            'div',
            {
              display: 'flex',
              flexDirection: 'column',
              marginTop: 'auto',
              marginBottom: 'auto',
              maxWidth: 980,
            },
            [
              h('div', { display: 'flex', alignItems: 'center', marginBottom: 22 }, [
                h('div', {
                  width: 16,
                  height: 18,
                  display: 'flex',
                  backgroundColor: C.honey,
                  borderRadius: 3,
                }),
                h(
                  'span',
                  {
                    marginLeft: 14,
                    fontFamily: 'JetBrains Mono',
                    fontSize: 22,
                    letterSpacing: 3,
                    textTransform: 'uppercase',
                    color: C.honeyText,
                  },
                  c.eyebrow,
                ),
              ]),
              h(
                'div',
                {
                  display: 'flex',
                  flexWrap: 'wrap',
                  fontSize: titleSize,
                  fontWeight: 700,
                  lineHeight: 1.04,
                  letterSpacing: -2.4,
                },
                titleNodes(clamp(c.title, 90), c.highlight),
              ),
              c.description
                ? h(
                    'div',
                    {
                      display: 'flex',
                      marginTop: 26,
                      fontSize: 28,
                      lineHeight: 1.45,
                      color: C.muted,
                      maxWidth: 940,
                    },
                    clamp(c.description, 150),
                  )
                : h('div', { display: 'flex' }),
            ],
          ),
          h(
            'div',
            {
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingTop: 26,
              borderTop: `1.5px solid ${C.line}`,
              fontFamily: 'JetBrains Mono',
              fontSize: 22,
              color: C.dim,
            },
            [
              h('span', { display: 'flex' }, c.url),
              h('span', { display: 'flex', color: C.muted }, c.footnote ?? ''),
            ],
          ),
        ],
      ),
    ],
  );
}

export async function renderOgImage(c: OgCard): Promise<Uint8Array> {
  // satori's types expect React elements; this plain object tree has the same shape.
  const markup = await satori(card(c) as unknown as Parameters<typeof satori>[0], {
    width: OG_WIDTH,
    height: OG_HEIGHT,
    fonts: FONTS,
  });
  return new Resvg(markup, { fitTo: { mode: 'width', value: OG_WIDTH } }).render().asPng();
}

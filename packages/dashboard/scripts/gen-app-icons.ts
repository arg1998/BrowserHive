/** @module dashboard/scripts/gen-app-icons — rasterises the app-icon SVGs (`src/assets/app-icon/`) into
 * `public/icons/` with the Playwright Chromium already in the dev dependencies, and writes
 * `icons.stamp.json` (04 §18.3). `--check` needs no browser: it compares the source hashes with the
 * stamp and reads only the PNG headers (IHDR), never PNG bytes, which differ between rasterisers.
 *
 * Run as `bun run gen:icons [--check]` from the repository root.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const packageRoot = join(import.meta.dir, '..');
/** Where the SVG sources and the stamp live (never shipped). */
export const SOURCE_DIR = join(packageRoot, 'src', 'assets', 'app-icon');
/** Where the generated icons are published from (`/icons/…`). */
export const OUTPUT_DIR = join(packageRoot, 'public', 'icons');
/** The stamp file. */
export const STAMP_PATH = join(SOURCE_DIR, 'icons.stamp.json');

/** The two icon sources. */
export type IconSource = 'app.svg' | 'maskable.svg';

/** PNG colour types the icons use: 6 = truecolour with alpha, 2 = truecolour (opaque). */
export type PngColorType = 2 | 6;

/** One rasterised output. */
export interface PngOutput {
  readonly file: string;
  readonly source: IconSource;
  readonly size: number;
  readonly colorType: PngColorType;
}

/** The five PNGs of 04 §18.1: `any` icons keep their transparency, the others are opaque. */
export const PNG_OUTPUTS: readonly PngOutput[] = [
  { file: 'app-192.png', source: 'app.svg', size: 192, colorType: 6 },
  { file: 'app-512.png', source: 'app.svg', size: 512, colorType: 6 },
  { file: 'maskable-192.png', source: 'maskable.svg', size: 192, colorType: 2 },
  { file: 'maskable-512.png', source: 'maskable.svg', size: 512, colorType: 2 },
  { file: 'apple-touch-icon.png', source: 'maskable.svg', size: 180, colorType: 2 },
];

/** `app.svg` is also published as is (`/icons/app.svg`, `sizes: any`). */
export const COPIED_SVG = 'app.svg';

/** The stamp's shape. */
export interface IconStamp {
  readonly sources: Readonly<Record<IconSource, string>>;
  readonly outputs: readonly PngOutput[];
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sourceHashes(): Record<IconSource, string> {
  return {
    'app.svg': sha256(readFileSync(join(SOURCE_DIR, 'app.svg'))),
    'maskable.svg': sha256(readFileSync(join(SOURCE_DIR, 'maskable.svg'))),
  };
}

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

/** What the IHDR chunk says; `null` when the bytes are not a PNG. */
export interface PngHeader {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  readonly colorType: number;
}

/** Reads the IHDR of a PNG from its first 33 bytes (signature, chunk length and type, 13 data bytes). */
export function readPngHeader(bytes: Uint8Array): PngHeader | null {
  if (bytes.length < 33) return null;
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) if (bytes[i] !== PNG_SIGNATURE[i]) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = String.fromCharCode(...bytes.subarray(12, 16));
  if (view.getUint32(8) !== 13 || type !== 'IHDR') return null;
  return {
    width: view.getUint32(16),
    height: view.getUint32(20),
    bitDepth: view.getUint8(24),
    colorType: view.getUint8(25),
  };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Encodes 8-bit RGBA pixels (un-premultiplied, row-major) as a PNG of `colorType`: 6 keeps the
 * alpha channel, 2 drops it (the caller guarantees the pixels are opaque). Each row uses the PNG
 * filter with the smallest sum of absolute values, the usual heuristic.
 */
export function encodePng(
  rgba: Uint8Array,
  width: number,
  height: number,
  colorType: PngColorType,
): Uint8Array {
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const rows: Uint8Array[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = new Uint8Array(stride);
    for (let x = 0; x < width; x += 1) {
      for (let ch = 0; ch < channels; ch += 1) {
        row[x * channels + ch] = rgba[(y * width + x) * 4 + ch] ?? 0;
      }
    }
    rows.push(row);
  }
  const filtered = new Uint8Array(height * (stride + 1));
  const candidate = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const row = rows[y] ?? new Uint8Array(stride);
    const prev = rows[y - 1];
    let best = 0;
    let bestScore = Number.POSITIVE_INFINITY;
    let bestBytes = new Uint8Array(stride);
    for (let filter = 0; filter <= 4; filter += 1) {
      let score = 0;
      for (let i = 0; i < stride; i += 1) {
        const raw = row[i] ?? 0;
        const left = i >= channels ? (row[i - channels] ?? 0) : 0;
        const up = prev?.[i] ?? 0;
        const upLeft = i >= channels ? (prev?.[i - channels] ?? 0) : 0;
        const predictor =
          filter === 0
            ? 0
            : filter === 1
              ? left
              : filter === 2
                ? up
                : filter === 3
                  ? Math.floor((left + up) / 2)
                  : paeth(left, up, upLeft);
        const value = (raw - predictor) & 0xff;
        candidate[i] = value;
        score += value < 128 ? value : 256 - value;
      }
      if (score < bestScore) {
        bestScore = score;
        best = filter;
        bestBytes = candidate.slice();
      }
    }
    filtered[y * (stride + 1)] = best;
    filtered.set(bestBytes, y * (stride + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  const parts = [
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(filtered, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Problems `--check` finds (empty when everything is up to date). */
export function checkIcons(): string[] {
  if (!existsSync(STAMP_PATH)) return [`missing ${STAMP_PATH}; run \`bun run gen:icons\``];
  const stamp = JSON.parse(readFileSync(STAMP_PATH, 'utf8')) as IconStamp;
  const problems: string[] = [];
  const hashes = sourceHashes();
  for (const source of ['app.svg', 'maskable.svg'] as const) {
    if (stamp.sources[source] !== hashes[source]) {
      problems.push(`${source} changed since the icons were generated`);
    }
  }
  const copied = join(OUTPUT_DIR, COPIED_SVG);
  if (!existsSync(copied)) problems.push(`missing public/icons/${COPIED_SVG}`);
  else if (sha256(readFileSync(copied)) !== hashes['app.svg']) {
    problems.push(`public/icons/${COPIED_SVG} differs from its source`);
  }
  for (const output of PNG_OUTPUTS) {
    const path = join(OUTPUT_DIR, output.file);
    if (!existsSync(path)) {
      problems.push(`missing public/icons/${output.file}`);
      continue;
    }
    const header = readPngHeader(readFileSync(path).subarray(0, 33));
    if (header === null) problems.push(`public/icons/${output.file} is not a PNG`);
    else if (
      header.width !== output.size ||
      header.height !== output.size ||
      header.colorType !== output.colorType
    ) {
      problems.push(
        `public/icons/${output.file} is ${header.width}x${header.height} colour type ${header.colorType}; expected ${output.size}x${output.size} colour type ${output.colorType}`,
      );
    }
  }
  return problems;
}

async function generate(): Promise<void> {
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    mkdirSync(OUTPUT_DIR, { recursive: true });
    for (const output of PNG_OUTPUTS) {
      const svg = readFileSync(join(SOURCE_DIR, output.source), 'utf8').replace(
        '<svg ',
        `<svg width="${output.size}" height="${output.size}" `,
      );
      // Draw the SVG onto a canvas at the target size: Chromium rasterises the vector at that
      // size, and `getImageData` returns un-premultiplied RGBA that `encodePng` writes as is.
      const base64 = await page.evaluate(
        async ({ markup, size }) => {
          const image = new Image(size, size);
          image.src = `data:image/svg+xml;base64,${btoa(markup)}`;
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = size;
          canvas.height = size;
          const context = canvas.getContext('2d');
          if (context === null) throw new Error('no 2d context');
          context.drawImage(image, 0, 0, size, size);
          const data = context.getImageData(0, 0, size, size).data;
          let binary = '';
          for (let i = 0; i < data.length; i += 0x8000) {
            binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
          }
          return btoa(binary);
        },
        { markup: svg, size: output.size },
      );
      const rgba = Uint8Array.from(Buffer.from(base64, 'base64'));
      if (output.colorType === 2) {
        for (let i = 3; i < rgba.length; i += 4) {
          if (rgba[i] !== 255) throw new Error(`${output.file}: ${output.source} is not opaque`);
        }
      }
      writeFileSync(
        join(OUTPUT_DIR, output.file),
        encodePng(rgba, output.size, output.size, output.colorType),
      );
      console.log(`gen:icons: wrote public/icons/${output.file}`);
    }
  } finally {
    await browser.close();
  }
  copyFileSync(join(SOURCE_DIR, COPIED_SVG), join(OUTPUT_DIR, COPIED_SVG));
  const stamp: IconStamp = { sources: sourceHashes(), outputs: PNG_OUTPUTS };
  writeFileSync(STAMP_PATH, `${JSON.stringify(stamp, null, 2)}\n`);
  console.log('gen:icons: wrote src/assets/app-icon/icons.stamp.json');
}

if (import.meta.main) {
  if (process.argv.includes('--check')) {
    const problems = checkIcons();
    if (problems.length > 0) {
      console.error(`gen:icons --check failed:\n  ${problems.join('\n  ')}`);
      console.error('Run `bun run gen:icons` and commit the result.');
      process.exit(1);
    }
    console.log('gen:icons: up to date');
  } else {
    await generate();
  }
}

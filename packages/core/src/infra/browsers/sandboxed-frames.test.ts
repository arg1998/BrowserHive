/** @module infra/browsers/sandboxed-frames.test — the sandboxed-frames switch: when a template host gets it, and that it repeats the installed Patchright's own `--disable-features` list (Chromium keeps only the last such switch). */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  ISOLATE_SANDBOXED_IFRAMES,
  PATCHRIGHT_DISABLED_FEATURES,
  SANDBOXED_FRAMES_IN_PROCESS_ARG,
  sandboxedFramesArgs,
} from './sandboxed-frames.ts';

/** The feature names of Patchright's `disabledFeatures = [...]` in its installed bundle. */
function installedPatchrightFeatures(): string[] {
  const require = createRequire(import.meta.url);
  const bundle = readFileSync(require.resolve('patchright-core/lib/coreBundle'), 'utf8');
  const start = bundle.indexOf('disabledFeatures = [');
  expect(start).toBeGreaterThan(-1);
  const end = bundle.indexOf('].filter(Boolean)', start);
  expect(end).toBeGreaterThan(start);
  const body = bundle
    .slice(start, end)
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  return [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? '');
}

describe('sandboxed frames switch', () => {
  it('repeats the installed Patchright list (update PATCHRIGHT_DISABLED_FEATURES on a mismatch)', () => {
    expect([...PATCHRIGHT_DISABLED_FEATURES]).toEqual(installedPatchrightFeatures());
  });

  it('is one --disable-features switch: Patchright list, then IsolateSandboxedIframes', () => {
    expect(SANDBOXED_FRAMES_IN_PROCESS_ARG).toBe(
      `--disable-features=${PATCHRIGHT_DISABLED_FEATURES.join(',')},${ISOLATE_SANDBOXED_IFRAMES}`,
    );
  });

  it('is on for stealth or "Deny clipboard writes", off otherwise', () => {
    expect(sandboxedFramesArgs({ stealth: false })).toEqual([]);
    expect(sandboxedFramesArgs({ stealth: false, denyClipboardWrites: false })).toEqual([]);
    expect(sandboxedFramesArgs({ stealth: true })).toEqual([SANDBOXED_FRAMES_IN_PROCESS_ARG]);
    expect(sandboxedFramesArgs({ stealth: false, denyClipboardWrites: true })).toEqual([
      SANDBOXED_FRAMES_IN_PROCESS_ARG,
    ]);
  });
});

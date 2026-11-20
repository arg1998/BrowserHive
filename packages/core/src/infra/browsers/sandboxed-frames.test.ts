/** @module infra/browsers/sandboxed-frames.test — the sandboxed-frames switch: when a browser gets it, that it repeats the installed Patchright's own `--disable-features` list (Chromium keeps only the last such switch), and the folding of several such switches into one. */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  foldDisableFeatures,
  ISOLATE_SANDBOXED_IFRAMES,
  keepsDriverDisableFeatures,
  PATCHRIGHT_DISABLE_FEATURES_ARG,
  PATCHRIGHT_DISABLED_FEATURES,
  SANDBOXED_FRAMES_ARG,
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
    expect(sandboxedFramesArgs({ stealth: true })).toEqual([SANDBOXED_FRAMES_ARG]);
    expect(sandboxedFramesArgs({ stealth: false, denyClipboardWrites: true })).toEqual([
      SANDBOXED_FRAMES_ARG,
    ]);
    // Folded on the launch path: the whole switch, Patchright's list first.
    expect(foldDisableFeatures(sandboxedFramesArgs({ stealth: true }), true)).toEqual([
      SANDBOXED_FRAMES_IN_PROCESS_ARG,
    ]);
  });

  it('folds every --disable-features switch into one, last, without repeats', () => {
    const list = PATCHRIGHT_DISABLED_FEATURES.join(',');
    expect(foldDisableFeatures(['--a', '--b=1'], true)).toEqual(['--a', '--b=1']);
    expect(
      foldDisableFeatures(
        [
          '--disable-features=Foo',
          '--a',
          SANDBOXED_FRAMES_IN_PROCESS_ARG,
          '-disable-features=Foo,,Bar',
        ],
        true,
      ),
    ).toEqual(['--a', `--disable-features=${list},Foo,${ISOLATE_SANDBOXED_IFRAMES},Bar`]);
    expect(foldDisableFeatures([SANDBOXED_FRAMES_IN_PROCESS_ARG], true)).toEqual([
      SANDBOXED_FRAMES_IN_PROCESS_ARG,
    ]);
    expect(foldDisableFeatures(['--disable-features', '--x'], false)).toEqual([
      '--x',
      '--disable-features=',
    ]);
    // Not a --disable-features switch: a longer name, or the enabling one.
    expect(foldDisableFeatures(['--disable-features-x=1', '--enable-features=Foo'], true)).toEqual([
      '--disable-features-x=1',
      '--enable-features=Foo',
    ]);
  });

  it("knows when ignoreDefaultArgs drops Patchright's own switch", () => {
    expect(keepsDriverDisableFeatures(undefined)).toBe(true);
    expect(keepsDriverDisableFeatures(false)).toBe(true);
    expect(keepsDriverDisableFeatures(['--enable-automation'])).toBe(true);
    expect(keepsDriverDisableFeatures(true)).toBe(false);
    expect(keepsDriverDisableFeatures([PATCHRIGHT_DISABLE_FEATURES_ARG])).toBe(false);
  });
});

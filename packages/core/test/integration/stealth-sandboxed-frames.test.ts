/// <reference lib="dom" />
/** @module test/integration/stealth-sandboxed-frames — an exclusive stealth session presents its identity in sandboxed `srcdoc` frames too (D58, D-79): with Chromium's `IsolateSandboxedIframes` such a frame runs out of process and the stealth init script never reaches it. */

import { describe, expect, it } from 'bun:test';
import {
  ISOLATE_SANDBOXED_IFRAMES,
  PATCHRIGHT_DISABLED_FEATURES,
} from '../../src/infra/browsers/sandboxed-frames.ts';
import { evalMain, type SessionRequest, useDriverFixtures } from './driver-fixture.ts';

/** What `/sandboxed-frames` reads in each frame (see fixture-server). */
interface FrameIdentity {
  userAgent: string;
  uaPlatform: string | null;
  brands: string[] | null;
  webdriver: boolean;
  deviceMemory: number | undefined;
  hardwareConcurrency: number;
  screen: { width: number; height: number; availWidth: number; availHeight: number };
  outer: { width: number; height: number };
  screenWidthGetter: string;
}

type Frames = Partial<Record<'main' | 'sandboxed' | 'nested', FrameIdentity>>;
type Session = Awaited<ReturnType<ReturnType<typeof useDriverFixtures>['state']['launch']>>;

/** The three frames' identities once the two sandboxed frames have posted theirs. */
async function readFrames(session: Session): Promise<Required<Frames>> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const frames = await evalMain(
      session,
      () => (window as unknown as { __frames?: Frames }).__frames ?? {},
    );
    if (frames.main && frames.sandboxed && frames.nested) return frames as Required<Frames>;
    if (Date.now() > deadline) throw new Error(`frames never posted: ${JSON.stringify(frames)}`);
    await Bun.sleep(50);
  }
}

/** The features of the browser's last `--disable-features` switch (the one Chromium keeps), from its own `chrome://version`. */
async function disabledFeatures(session: Session): Promise<string[]> {
  const page = await session.handle.context.newPage();
  try {
    await page.goto('chrome://version');
    const argv = (await page.locator('#command_line').textContent()) ?? '';
    const last = [...argv.matchAll(/(?:^|\s)--?disable-features=(\S*)/g)].at(-1);
    return last?.[1]?.split(',') ?? [];
  } finally {
    await page.close();
  }
}

/** Every frame of `/sandboxed-frames` presents the main frame's identity, which is the stealth one. */
async function expectOneIdentity(session: Session, url: string): Promise<void> {
  await session.page.goto(url);
  const { main, sandboxed, nested } = await readFrames(session);
  expect(main.userAgent).not.toContain('HeadlessChrome');
  expect(main.brands).toContain('Google Chrome');
  expect(sandboxed).toEqual(main);
  expect(nested).toEqual(main);
}

describe('stealth: sandboxed srcdoc frames (real browser)', () => {
  const { state } = useDriverFixtures();

  for (const fingerprint of [false, true]) {
    it(`a sandboxed srcdoc frame and a nested one present the main frame's identity (fingerprint ${fingerprint ? 'on' : 'off'})`, async () => {
      // Out of process (Chromium's default) they presented `HeadlessChrome` with Chromium's own
      // brands, and with fingerprint on the real screen instead of the presented one.
      const session = await state.launch({ slug: 'sbx', stealth: true, fingerprint });
      await expectOneIdentity(session, state.fixture.url('/sandboxed-frames'));
      const features = await disabledFeatures(session);
      expect(features).toEqual([...PATCHRIGHT_DISABLED_FEATURES, ISOLATE_SANDBOXED_IFRAMES]);
    });
  }

  it("folds a caller's own --disable-features into the one switch Chromium keeps", async () => {
    const request: SessionRequest = {
      slug: 'sbx-merge',
      stealth: true,
      launchOptions: { args: ['-disable-features=MediaSessionService'] },
    };
    const session = await state.launch(request);
    await expectOneIdentity(session, state.fixture.url('/sandboxed-frames'));
    expect(await disabledFeatures(session)).toEqual([
      ...PATCHRIGHT_DISABLED_FEATURES,
      ISOLATE_SANDBOXED_IFRAMES,
      'MediaSessionService',
    ]);
  });

  it("a non-stealth session keeps Chromium's default process model (no switch of ours)", async () => {
    const session = await state.launch({ slug: 'sbx-plain', stealth: false });
    expect(await disabledFeatures(session)).toEqual([...PATCHRIGHT_DISABLED_FEATURES]);
  });
});

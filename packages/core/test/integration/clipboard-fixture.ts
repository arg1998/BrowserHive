/// <reference lib="dom" />
/** @module test/integration/clipboard-fixture — what the "Deny clipboard writes" suites drive on a real template host (spec 13 §2.1, D18): the operator's clipboard read and seeded from another site, the clipboard fixture page opened in a session, real clicks on its buttons and frames, and the frames themselves. */

import type { CDPSession, Frame, Page } from 'patchright';
import type { Session } from '../../src/domain/session/session.ts';
import type { TemplateWorld } from './template-fixture.ts';

/** The site that reads (and seeds) the clipboard: not the page under test. */
const READER = 'https://site-b.test';

export function pageOf(session: Session): Page {
  const view = session.view;
  if (view === null) throw new Error(`${session.id} has no view`);
  return view.page;
}

/**
 * The clipboard as the operator sees it: read (and seeded) by a page on another site that may. The
 * grants live on a browser session kept open (Chromium drops a session's overrides when it
 * detaches) and are renewed per call: lifting the denial resets every override of the context.
 */
export class ClipboardReader {
  constructor(
    private readonly cdp: CDPSession,
    private readonly reader: Page,
  ) {}

  async #grant(name: 'clipboard-read' | 'clipboard-write'): Promise<void> {
    await this.cdp.send('Browser.setPermission', {
      permission: { name },
      setting: 'granted',
      origin: READER,
    });
  }

  async read(back: Page): Promise<string> {
    await this.#grant('clipboard-read');
    await this.reader.bringToFront();
    const text = await this.reader.evaluate(() => navigator.clipboard.readText());
    await back.bringToFront();
    return text;
  }

  /** Puts `text` on the clipboard from the reader's site (the operator's own content). */
  async seed(text: string, back: Page): Promise<void> {
    await this.#grant('clipboard-write');
    await this.reader.bringToFront();
    await this.reader.evaluate((value) => navigator.clipboard.writeText(value), text);
    await back.bringToFront();
  }
}

/** Opens the clipboard page in one session and a reader page in another. */
export async function setUp(
  w: TemplateWorld,
  agent?: Session,
): Promise<{ page: Page; clipboard: ClipboardReader }> {
  const reader = pageOf(await w.launch('reader'));
  await reader.goto(`${READER}/landing`);
  const page = pageOf(agent ?? (await w.launch('agent')));
  await page.goto(w.sites.url('site-a.test', '/clipboard'));
  const browser = w.host().context.browser();
  if (browser === null) throw new Error('no browser');
  const cdp = await browser.newBrowserCDPSession();
  return { page, clipboard: new ClipboardReader(cdp, reader) };
}

/**
 * Clicks a fixture button (a real click: user activation) in a page or one of its frames and
 * returns the outcome it reports in that document's title.
 */
export async function press(target: Page | Frame, id: string): Promise<string> {
  await target.click(`#${id}`);
  // The title is read where it was waited for: Patchright's `title()` answers an empty string in an
  // out-of-process sandboxed `srcdoc` frame (it never saw that frame's navigation).
  const title = await target.waitForFunction(
    (prefix) => (document.title.startsWith(prefix) ? document.title : false),
    `${id}:`,
  );
  return String(await title.jsonValue()).slice(id.length + 1);
}

/**
 * The page's frame loaded from `host` (`sub.site-a.test`: same site; `cdn-a.test`: cross-site).
 * Patchright reports an empty URL for an out-of-process sandboxed `srcdoc` frame.
 */
export function frameOf(page: Page, host: string): Frame {
  const frame = page.frames().find((f) => f.url().startsWith(`https://${host}/`));
  if (frame === undefined) throw new Error(`no frame from ${host}`);
  return frame;
}

/** The frames loaded with the page, as `[host, frame]`. */
export function framesOf(page: Page): [string, Frame][] {
  return ['sub.site-a.test', 'cdn-a.test'].map((host) => [host, frameOf(page, host)]);
}

/** The frame of the `<iframe id>` in `parent` (a page or a frame). */
export async function frameById(parent: Page | Frame, id: string): Promise<Frame> {
  const frame = await (await parent.$(`#${id}`))?.contentFrame();
  if (frame === null || frame === undefined) throw new Error(`no frame #${id}`);
  return frame;
}

/**
 * The opaque sandboxed `srcdoc` frames (verify #84 N1) Patchright can drive, as `[label, frame]`:
 * the page's and the one inside the cross-site frame (which runs out of process). The one nested
 * in the page's is clicked through {@link clickNestedSandboxCopy}.
 */
export async function sandboxedFramesOf(page: Page): Promise<[string, Frame][]> {
  return [
    ['sandbox-srcdoc', await frameById(page, 'sandbox-srcdoc')],
    ['sandbox-child', await frameById(frameOf(page, 'cdn-a.test'), 'sandbox-child')],
  ];
}

/**
 * Clicks the copy button of the sandboxed frame nested in the page's sandboxed frame with the
 * mouse. Out of process, Patchright does not see that frame at all; the button comes first in both
 * documents, so it sits at the same offset inside each frame.
 */
export async function clickNestedSandboxCopy(page: Page): Promise<void> {
  const outer = await frameById(page, 'sandbox-srcdoc');
  await page.locator('#sandbox-srcdoc').scrollIntoViewIfNeeded();
  const outerBox = await page.locator('#sandbox-srcdoc').boundingBox();
  const button = await outer.locator('#own-copy').boundingBox();
  const nested = await outer.locator('#nested-sandbox').boundingBox();
  if (outerBox === null || button === null || nested === null) throw new Error('not laid out');
  await page.mouse.click(
    nested.x + (button.x - outerBox.x) + button.width / 2,
    nested.y + (button.y - outerBox.y) + button.height / 2,
  );
}

/** True when `frame` runs in a process of its own (only those have a DevTools session). */
export async function outOfProcess(w: TemplateWorld, frame: Frame): Promise<boolean> {
  const cdp = await w
    .host()
    .context.newCDPSession(frame)
    .catch(() => null);
  await cdp?.detach().catch(() => undefined);
  return cdp !== null;
}

export function permissionState(page: Page): Promise<string> {
  return page.evaluate(() =>
    navigator.permissions.query({ name: 'clipboard-write' as PermissionName }).then((s) => s.state),
  );
}

/** The buttons that replace the page's document and arm a rewrite of the next copy (N2). */
export const REPLACERS = ['docopen-hijack', 'docwrite-capture', 'docopen-realm'] as const;

/**
 * Opens a fresh clipboard page, replaces its document with `id` (`armed`, or what the button
 * reports instead), selects the field and copies as a person does; returns that outcome and what
 * landed on the clipboard.
 */
export async function copyAfterReplace(
  w: TemplateWorld,
  page: Page,
  clipboard: ClipboardReader,
  id: (typeof REPLACERS)[number],
): Promise<[string, string]> {
  await page.goto(w.sites.url('site-a.test', '/clipboard'));
  await clipboard.seed('operator text', page);
  const outcome = await press(page, id);
  if ((await press(page, 'select-all')) !== 'true') throw new Error('select-all failed');
  await page.keyboard.press('ControlOrMeta+C');
  return [outcome, await clipboard.read(page)];
}

/** The page coordinates of the centre of each button, by id (a restored page is clicked by these). */
export async function buttonsOf(
  page: Page,
  groups: readonly (readonly [Frame, readonly string[]])[],
): Promise<Map<string, { x: number; y: number }>> {
  const points = new Map<string, { x: number; y: number }>();
  for (const [frame, ids] of groups) {
    for (const id of ids) {
      const box = await frame.locator(`#${id}`).boundingBox();
      if (box === null) throw new Error(`#${id} is not visible`);
      points.set(id, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
    }
  }
  void page;
  return points;
}

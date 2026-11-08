/** @module interface/mcp/tools/files/capture — the managed-downloads code path `download_file`, `navigate` and `new_tab` share: save a Playwright download, and a `goto` that may turn into one. */

import { basename, join } from 'node:path';
import type { Download, Page, Response } from 'playwright';
import { sessionDirLayout } from '../../../../app/sessions/profile-dir.ts';
import type { Session } from '../../../../domain/session/session.ts';
import { isAppError } from '../../../../kernel/errors/app-error.ts';
import type { ToolCallContext } from '../../context.ts';
import { firstLine, navigation, registryError } from '../shared.ts';

/** A download saved into `<data-dir>/sessions/<id>/downloads/`, in `download_file`'s field names. */
export interface SavedDownload {
  readonly saved_to: string;
  readonly suggested_name: string;
  readonly size: number;
}

/**
 * Saves `download` into the session's managed downloads dir under its suggested name, or under the
 * basename of `saveAs`, and reports the absolute path and byte size.
 */
export async function saveDownload(
  ctx: ToolCallContext,
  sessionId: string,
  download: Download,
  saveAs?: string,
): Promise<SavedDownload> {
  const dir = sessionDirLayout(ctx.services.runtime.dataDir).forSession(sessionId).downloads;
  await ctx.services.fs.mkdir(dir);
  const suggested = download.suggestedFilename();
  const name = saveAs !== undefined ? basename(saveAs) : suggested;
  const savedTo = join(dir, name);
  await download.saveAs(savedTo);
  const size = await ctx.services.fs.fileSize(savedTo);
  return { saved_to: savedTo, suggested_name: suggested, size };
}

/** What a `goto` that may start a download produced. */
export type GotoOutcome =
  | { readonly kind: 'page'; readonly response: Response | null }
  | { readonly kind: 'download'; readonly download: SavedDownload };

/** The navigation a tool asked for. */
export interface GotoTarget {
  readonly url: string;
  readonly timeoutMs: number;
  readonly tabId?: string | undefined;
  readonly waitUntil: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
}

/** Playwright's `goto` rejects with this when the response is an attachment (1.63: `goto: Download is starting`). */
const DOWNLOAD_STARTING_RE = /Download is starting/;

/**
 * `page.goto` for `navigate` and `new_tab`. A URL served as an attachment does not load a page; the
 * browser starts a download and the tab keeps its document. The `download` listener is armed before
 * the navigation, so the event cannot be missed, and the file is saved through
 * {@link saveDownload}, bounded by what is left of `timeoutMs` (`0` keeps Playwright's meaning: no
 * limit). A save failure or the budget running out answers `DOWNLOAD_FAILED`. Every other outcome
 * is the plain navigation's (timeouts, net errors, through {@link navigation}).
 */
export async function gotoCapturingDownload(
  ctx: ToolCallContext,
  session: Session,
  page: Page,
  target: GotoTarget,
): Promise<GotoOutcome> {
  const startedAt = ctx.services.clock.now();
  const listener = downloadListener();
  page.on('download', listener.onDownload);
  try {
    try {
      const response = await navigation(ctx, session, target, () =>
        page.goto(target.url, { waitUntil: target.waitUntil, timeout: target.timeoutMs }),
      );
      return { kind: 'page', response };
    } catch (err) {
      // The goto either reported the download, or failed (net::ERR_ABORTED) after one started.
      const reported = err instanceof Error && DOWNLOAD_STARTING_RE.test(err.message);
      if (!reported && listener.first() === undefined) throw err;
    }
    const budgetMs =
      target.timeoutMs === 0
        ? null
        : Math.max(0, target.timeoutMs - (ctx.services.clock.now() - startedAt));
    const download = await saveWithinBudget(ctx, session.id, listener, budgetMs, target.timeoutMs);
    return { kind: 'download', download };
  } catch (err) {
    if (isAppError(err)) throw err;
    throw registryError('DOWNLOAD_FAILED', { reason: firstLine(err) }, err);
  } finally {
    page.off('download', listener.onDownload);
  }
}

/** The first `download` event of a page, as a promise armed before anything can fire it. */
interface DownloadListener {
  readonly onDownload: (download: Download) => void;
  readonly arrived: Promise<Download>;
  first(): Download | undefined;
}

function downloadListener(): DownloadListener {
  let first: Download | undefined;
  let arrive: (download: Download) => void = () => undefined;
  const arrived = new Promise<Download>((resolve) => {
    arrive = resolve;
  });
  return {
    arrived,
    first: () => first,
    onDownload: (download) => {
      if (first !== undefined) return;
      first = download;
      arrive(download);
    },
  };
}

/**
 * Saves the download the listener caught. When `budgetMs` runs out first (no event, or a transfer
 * still running), the download is cancelled and the call answers `DOWNLOAD_FAILED`.
 */
async function saveWithinBudget(
  ctx: ToolCallContext,
  sessionId: string,
  listener: DownloadListener,
  budgetMs: number | null,
  timeoutMs: number,
): Promise<SavedDownload> {
  const saving = listener.arrived.then((download) => saveDownload(ctx, sessionId, download));
  if (budgetMs === null) return saving;
  const timer = new AbortController();
  const expired = ctx.services.clock.sleep(budgetMs, timer.signal).then(
    () => true,
    () => false,
  );
  try {
    const timedOut = await Promise.race([saving.then(() => false), expired]);
    if (!timedOut) return await saving;
    // The save keeps running against the cancelled download; its rejection is expected.
    saving.catch(() => undefined);
    await listener
      .first()
      ?.cancel()
      .catch(() => undefined);
    throw registryError('DOWNLOAD_FAILED', {
      reason: `the download did not finish within ${timeoutMs} ms`,
    });
  } finally {
    timer.abort();
  }
}

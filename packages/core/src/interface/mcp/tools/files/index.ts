/** @module interface/mcp/tools/files — upload_file (uploads sandbox), download_file (managed downloads dir). */

import { basename, join } from 'node:path';
import type { Download } from 'playwright';
import { sessionDirLayout } from '../../../../app/sessions/profile-dir.ts';
import { isAppError } from '../../../../kernel/errors/app-error.ts';
import { requireSession } from '../../context.ts';
import { defineTool, json, type ToolPack } from '../../definition.ts';
import { sandboxPath, sessionOwnership } from '../../policies.ts';
import { resolveUploadPath } from '../../sandbox.ts';
import { firstLine, pageOf, registryError } from '../shared.ts';

/** `upload_file`: every path must resolve under `<data-dir>/uploads/` before the page is touched. */
export const uploadFile = defineTool('upload_file', {
  policies: [sessionOwnership, sandboxPath('paths', 'upload')],
  async handler(ctx, args) {
    const session = requireSession(ctx);
    const page = pageOf(ctx, session, args.tab_id);
    const dataDir = ctx.services.runtime.dataDir;
    const resolved = await Promise.all(args.paths.map((p) => resolveUploadPath(dataDir, p)));
    try {
      await page.setInputFiles(args.selector, resolved, { timeout: args.timeout });
    } catch (err) {
      if (isAppError(err)) throw err;
      const classified = ctx.services.pageActions.classifyError(err, {
        selector: args.selector,
        timeoutMs: args.timeout,
        sessionId: session.id,
      });
      if (classified !== null && classified.code !== 'ELEMENT_NOT_ACTIONABLE') throw classified;
      throw registryError('UPLOAD_FAILED', { reason: firstLine(err) }, err);
    }
    return json({ session_id: session.id, selector: args.selector, ok: true as const });
  },
});

/** `download_file`: the download listener is armed before the click; `save_as` is a basename. */
export const downloadFile = defineTool('download_file', {
  policies: [sessionOwnership],
  async handler(ctx, args) {
    const session = requireSession(ctx);
    const page = pageOf(ctx, session, args.tab_id);
    const dir = sessionDirLayout(ctx.services.runtime.dataDir).forSession(session.id).downloads;
    try {
      await ctx.services.fs.mkdir(dir);
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: args.timeout }),
        page.click(args.trigger_selector, { timeout: args.timeout }),
      ]);
      const saved: Download = download;
      const suggested = saved.suggestedFilename();
      const name = args.save_as !== undefined ? basename(args.save_as) : suggested;
      const savedTo = join(dir, name);
      await saved.saveAs(savedTo);
      const size = await ctx.services.fs.fileSize(savedTo);
      return json({ session_id: session.id, saved_to: savedTo, suggested_name: suggested, size });
    } catch (err) {
      if (isAppError(err)) throw err;
      throw registryError('DOWNLOAD_FAILED', { reason: firstLine(err) }, err);
    }
  },
});

/** The files pack. */
export const filesPack: ToolPack = { id: 'files', tools: [uploadFile, downloadFile] };

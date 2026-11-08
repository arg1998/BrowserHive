/** @module interface/mcp/tools/files — upload_file (uploads sandbox), download_file (managed downloads dir). */

import { isAppError } from '../../../../kernel/errors/app-error.ts';
import { requireSession } from '../../context.ts';
import { defineTool, json, type ToolPack } from '../../definition.ts';
import { sandboxPath, sessionOwnership } from '../../policies.ts';
import { resolveUploadPath } from '../../sandbox.ts';
import { firstLine, pageOf, registryError } from '../shared.ts';
import { saveDownload } from './capture.ts';

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
    try {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: args.timeout }),
        page.click(args.trigger_selector, { timeout: args.timeout }),
      ]);
      const saved = await saveDownload(ctx, session.id, download, args.save_as);
      return json({ session_id: session.id, ...saved });
    } catch (err) {
      if (isAppError(err)) throw err;
      throw registryError('DOWNLOAD_FAILED', { reason: firstLine(err) }, err);
    }
  },
});

/** The files pack. */
export const filesPack: ToolPack = { id: 'files', tools: [uploadFile, downloadFile] };

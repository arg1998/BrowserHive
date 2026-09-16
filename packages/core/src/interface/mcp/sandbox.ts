/** @module interface/mcp/sandbox — the two tool-facing path sandboxes over the kernel `paths` helpers: screenshot destinations and upload sources. */

import { join } from 'node:path';
import { sessionDirLayout } from '../../app/sessions/profile-dir.ts';
import { resolveWithinRoots } from '../../kernel/paths.ts';

/** `<data-dir>/uploads` (D-24). */
export const UPLOADS_DIR_NAME = 'uploads';

/** Absolute uploads sandbox for a data dir. */
export function uploadsDir(dataDir: string): string {
  return join(dataDir, UPLOADS_DIR_NAME);
}

/**
 * Resolves and validates a `screenshot.save_path`: a relative path lands in the session's own
 * directory; an absolute one must resolve under the session dir or the uploads sandbox.
 *
 * @throws `PATH_NOT_ALLOWED`
 */
export function resolveScreenshotSavePath(
  dataDir: string,
  sessionId: string,
  savePath: string,
): Promise<string> {
  const sessionDir = sessionDirLayout(dataDir).forSession(sessionId).root;
  return resolveWithinRoots(savePath, {
    roots: [sessionDir, uploadsDir(dataDir)],
    base: sessionDir,
    relativeHint: "resolved against the session directory, e.g. 'shot.png'",
  });
}

/**
 * Resolves and validates one `upload_file` path; it must resolve under `<data-dir>/uploads/`
 * after symlinks (a missing file still fails containment when it points elsewhere).
 *
 * @throws `PATH_NOT_ALLOWED`
 */
export function resolveUploadPath(dataDir: string, uploadPath: string): Promise<string> {
  return resolveWithinRoots(uploadPath, { roots: [uploadsDir(dataDir)] });
}

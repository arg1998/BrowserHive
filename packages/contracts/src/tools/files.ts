/** @module contracts/tools/files — upload_file and download_file contracts */
import { z } from 'zod';
import { annotations, SESSION_ERRORS, SelectorAck, SINCE, TabId, Timeout } from './shared.ts';
import { defineTool } from './types.ts';

/** `upload_file`: every path must resolve under `<data-dir>/uploads/` before the page is touched. */
export const UPLOAD_FILE = defineTool({
  name: 'upload_file',
  title: 'Upload file',
  description:
    'Set the files on a file <input> matched by selector. Every path MUST resolve under the ' +
    "server's uploads sandbox (<data-dir>/uploads/); out-of-tree paths fail with PATH_NOT_ALLOWED.",
  input: z.object({
    session_id: z.string(),
    selector: z.string().min(1),
    paths: z.array(z.string().min(1)).min(1, 'paths must include at least one file'),
    timeout: Timeout,
    tab_id: TabId,
  }),
  output: SelectorAck,
  annotations: annotations(false, false, true, false),
  pack: 'files',
  capability: 'mutate',
  errors: [...SESSION_ERRORS, 'TAB_NOT_FOUND', 'PATH_NOT_ALLOWED', 'UPLOAD_FAILED'],
  since: SINCE,
});

/** `download_file`: the download listener is armed before the trigger click. */
export const DOWNLOAD_FILE = defineTool({
  name: 'download_file',
  title: 'Download file',
  description:
    'Click a trigger element and capture the resulting download into the managed downloads dir ' +
    '(<data-dir>/sessions/<id>/downloads/). Returns the absolute saved path, the suggested ' +
    'filename, and the byte size.',
  input: z.object({
    session_id: z.string(),
    trigger_selector: z.string().min(1),
    timeout: Timeout,
    tab_id: TabId,
    save_as: z.string().optional(),
  }),
  output: z.object({
    session_id: z.string(),
    saved_to: z.string(),
    suggested_name: z.string(),
    size: z.number(),
  }),
  annotations: annotations(false, false, false, true),
  pack: 'files',
  capability: 'mutate',
  errors: [...SESSION_ERRORS, 'TAB_NOT_FOUND', 'DOWNLOAD_FAILED'],
  since: SINCE,
});

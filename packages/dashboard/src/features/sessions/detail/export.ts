/** @module features/sessions/detail/export — timeline export download: `GET …/export` negotiated on `Accept` (ndjson | csv), saved through a blob link; reports `X-Truncated` (spec 03 §4.2) */
import { appErrorFromResponse } from '@/lib/api/errors.ts';

/** Export formats. */
export const EXPORT_FORMATS = {
  ndjson: { accept: 'application/x-ndjson', ext: 'ndjson', label: 'NDJSON' },
  csv: { accept: 'text/csv', ext: 'csv', label: 'CSV' },
} as const;
/** Export format. */
export type ExportFormat = keyof typeof EXPORT_FORMATS;

/** File name for an export. */
export function exportFileName(slug: string, format: ExportFormat): string {
  return `${slug}-timeline.${EXPORT_FORMATS[format].ext}`;
}

/** Fetch the export and trigger a download; resolves `{ truncated }`. */
export async function downloadExport(
  url: string,
  slug: string,
  format: ExportFormat,
  doc: Document = document,
): Promise<{ readonly truncated: boolean }> {
  const response = await fetch(url, {
    headers: { Accept: EXPORT_FORMATS[format].accept },
    credentials: 'same-origin',
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    throw appErrorFromResponse(response.status, body, response.headers);
  }
  const blob = await response.blob();
  const href = URL.createObjectURL(blob);
  const link = doc.createElement('a');
  link.href = href;
  link.download = exportFileName(slug, format);
  doc.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(href);
  return { truncated: response.headers.get('X-Truncated') === 'true' };
}

/** Formats in menu order. */
export const EXPORT_FORMAT_IDS: readonly ExportFormat[] = ['ndjson', 'csv'];

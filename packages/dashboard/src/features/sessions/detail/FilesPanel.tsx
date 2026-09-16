/** @module features/sessions/detail/FilesPanel — Files & trace tab: the Playwright trace, the data directory and activity exports (spec 04 §12.3.5) */
import type { SessionDetail } from '@browserhive/contracts/http';
import { useApi } from '@/app/providers/AuthProvider.tsx';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { Panel } from '@/components/shared/Section.tsx';
import { Button } from '@/components/ui/button.tsx';
import { toAppError } from '@/lib/api/errors.ts';
import { ICONS } from '@/lib/icons.ts';
import { DataDirSection } from './DataDirSection.tsx';
import { downloadExport, EXPORT_FORMAT_IDS, EXPORT_FORMATS } from './export.ts';
import { TraceSection } from './TraceSection.tsx';

/** Files & trace tab. */
export function FilesPanel({ detail }: { readonly detail: SessionDetail }) {
  const api = useApi();
  const toast = useToast();
  const Download = ICONS.download;
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <TraceSection detail={detail} />
      <DataDirSection detail={detail} />
      <Panel
        title="Export activity"
        description="Every tool call, page visit, attention request, vault fill and blocked request of this session."
      >
        <div className="flex flex-wrap gap-2">
          {EXPORT_FORMAT_IDS.map((format) => (
            <Button
              key={format}
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void downloadExport(
                  api.url('exportSession', { session_id: detail.session.session_id }),
                  detail.session.slug,
                  format,
                )
                  .then(({ truncated }) => {
                    if (truncated) toast.warning({ title: 'Export truncated at 100,000 rows' });
                  })
                  .catch((error: unknown) => toast.fromError(toAppError(error), 'Export failed'));
              }}
            >
              <Download aria-hidden="true" /> {EXPORT_FORMATS[format].label}
            </Button>
          ))}
        </div>
      </Panel>
    </div>
  );
}

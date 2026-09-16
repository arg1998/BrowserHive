/** @module features/sessions/detail/DataDirSection — data directory panel: path (copy), "Show files" reveal with the result and a note for each of the four failure cases (spec 04 §12.3.5) */
import type { RevealDataDirResponse, SessionDetail } from '@browserhive/contracts/http';
import { CopyButton } from '@/components/shared/CopyButton.tsx';
import { Panel } from '@/components/shared/Section.tsx';
import { TonePill } from '@/components/shared/StatusBadge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Hint } from '@/components/ui/tooltip.tsx';
import { ICONS } from '@/lib/icons.ts';
import { useSessionMutations } from '../api.ts';
import { PathText } from './path-text.tsx';

/** Note under a reveal result, `null` when opened. */
export function revealNote(result: RevealDataDirResponse): string | null {
  if (result.opened) return null;
  switch (result.reason) {
    case 'missing':
      return 'This directory does not exist. It is created on demand, and removed when the session is deleted or purged.';
    case 'no_desktop':
      return 'No desktop session on the host running BrowserHive, so no file-manager window could be opened. Copy the path above.';
    case 'unsupported':
      return 'No file-manager opener is available on this platform. Copy the path above.';
    case 'failed':
    case undefined:
      return `The file manager could not be opened${result.detail !== undefined ? `: ${result.detail}` : ''}. Copy the path above.`;
    default:
      return null;
  }
}

const PILL = {
  opened: { label: 'opened on the host', tone: 'success' },
  no_desktop: { label: 'no desktop', tone: 'warn' },
  missing: { label: 'missing', tone: 'neutral' },
  unsupported: { label: 'unsupported', tone: 'neutral' },
  failed: { label: 'failed', tone: 'danger' },
} as const;

/** Data directory panel. */
export function DataDirSection({ detail }: { readonly detail: SessionDetail }) {
  const { reveal } = useSessionMutations(detail.session.session_id);
  const result = reveal.data;
  const Folder = ICONS.ftp;
  const tooltip = detail.data_dir.persistent
    ? 'Open the folder on the host: browser profile, trace, screenshots, downloads'
    : "Open the folder on the host: trace, screenshots, downloads (no profile, this session isn't persistent)";
  return (
    <Panel
      title="Data directory"
      description={
        detail.data_dir.persistent
          ? 'Browser profile, trace, screenshots and downloads.'
          : 'Trace, screenshots and downloads. No browser profile: this session is not persistent.'
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div
            data-reveal-scope=""
            className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border bg-muted/60 py-1.5 pr-1.5 pl-3 dark:bg-black/20"
          >
            <Folder aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            <PathText value={detail.data_dir.path} className="flex-1" />
            <CopyButton
              value={detail.data_dir.path}
              label="Copy data directory path"
              visibility="always"
            />
          </div>
          <Hint label={tooltip}>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={reveal.isPending}
              onClick={() => reveal.mutate()}
            >
              {reveal.isPending ? 'Opening…' : 'Show files'}
            </Button>
          </Hint>
        </div>
        {result !== undefined ? (
          <div className="flex flex-col items-start gap-1.5" role="status">
            <TonePill entry={PILL[result.opened ? 'opened' : (result.reason ?? 'failed')]} />
            {revealNote(result) !== null ? (
              <p className="text-sm text-muted-foreground">{revealNote(result)}</p>
            ) : null}
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

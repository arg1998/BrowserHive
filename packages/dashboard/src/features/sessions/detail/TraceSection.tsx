/** @module features/sessions/detail/TraceSection — trace artifact panel: file + size, Open trace viewer (grant token) and Download with the reason when unavailable, the `npx playwright show-trace` command, insecure-context notice (spec 04 §12.3.5) */
import type { SessionDetail } from '@browserhive/contracts/http';
import { Callout } from '@/components/shared/Callout.tsx';
import { CopyButton } from '@/components/shared/CopyButton.tsx';
import { Panel } from '@/components/shared/Section.tsx';
import { Button, buttonVariants } from '@/components/ui/button.tsx';
import { Hint } from '@/components/ui/tooltip.tsx';
import { formatBytes } from '@/lib/format/bytes.ts';
import { ICONS } from '@/lib/icons.ts';
import { useSessionTraceQuery } from '../api.ts';
import { PathText } from './path-text.tsx';
import { traceViewerHint, useTraceViewer } from './use-trace-viewer.ts';

/** Trace panel. */
export function TraceSection({ detail }: { readonly detail: SessionDetail }) {
  const id = detail.session.session_id;
  const hint = traceViewerHint(detail);
  const viewer = useTraceViewer(id);
  const info = useSessionTraceQuery(id, detail.trace.enabled);
  const size = info.data?.size_bytes ?? detail.trace.size_bytes;
  const command =
    info.data?.command ??
    (detail.trace.path !== null ? `npx playwright show-trace ${detail.trace.path}` : null);
  const downloadable = detail.trace.enabled && !detail.session.live;
  const secure = typeof window === 'undefined' || window.isSecureContext;
  const FileIcon = ICONS.layers;
  const External = ICONS.external;
  const Download = ICONS.download;
  return (
    <Panel
      title="Playwright trace"
      description="Every action, network request and DOM snapshot, replayable step by step."
      info={
        <>
          <p>
            The trace is written when the session closes. <b>Open trace viewer</b> replays it here
            with DOM snapshots, network and console; <code>trace.zip</code> also opens in a local
            Playwright install.
          </p>
          <p>Vault keystrokes are excluded from traces.</p>
        </>
      }
      infoDocs="dashboardSessionDetail"
    >
      <div className="flex flex-col gap-4">
        {!secure ? (
          <Callout
            tone="warn"
            title="The trace viewer needs a secure context"
            dismissible={{ key: 'traceViewer.insecure' }}
          >
            It uses a service worker, which browsers only allow on https or localhost. Download
            trace.zip and run the terminal command below instead.
          </Callout>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground dark:bg-white/[0.06]">
            <FileIcon aria-hidden="true" className="size-4" />
          </span>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="font-mono text-sm font-medium">trace.zip</span>
            <span className="text-sm text-muted-foreground">
              {size !== undefined && size !== null ? formatBytes(size) : hint.hint}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {downloadable ? (
              <a
                href={viewer.downloadUrl}
                download={`${detail.session.slug}-trace.zip`}
                className={buttonVariants({ variant: 'outline', size: 'sm' })}
              >
                <Download aria-hidden="true" /> Download
              </a>
            ) : null}
            <Hint label={hint.enabled ? null : hint.hint}>
              <span tabIndex={hint.enabled ? undefined : 0} className="inline-flex rounded-md">
                <Button
                  type="button"
                  size="sm"
                  disabled={!hint.enabled || viewer.opening}
                  onClick={() => void viewer.open()}
                >
                  <External aria-hidden="true" /> Open trace viewer
                </Button>
              </span>
            </Hint>
          </div>
        </div>
        {size !== undefined && size !== null && !hint.enabled ? (
          <p className="text-sm text-muted-foreground">{hint.hint}</p>
        ) : null}
        {command !== null ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Open it locally</span>
            <div
              data-reveal-scope=""
              className="flex items-center gap-2 rounded-lg border bg-muted/60 py-1.5 pr-1.5 pl-3 dark:bg-black/20"
            >
              <PathText value={command} className="flex-1" />
              <CopyButton value={command} label="Copy terminal command" visibility="always" />
            </div>
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

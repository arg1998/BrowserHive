/** @module features/sessions/detail/SessionHeader — session title (slug), state, id with copy, meta line (owner · browser · started · duration), primary actions (Live toggle, or the trace viewer once closed; Take over lives in the attention banner) and an overflow menu with the destructive actions behind confirms ; the id copies on click and the meta line never leaves a dangling separator or reflows every second; no second trace-viewer button on Files & trace */
import type { SessionDetail } from '@browserhive/contracts/http';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useApi } from '@/app/providers/AuthProvider.tsx';
import { useConfirm } from '@/app/providers/ConfirmProvider.tsx';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { copyText } from '@/components/shared/CopyButton.tsx';
import { PageHeader } from '@/components/shared/PageHeader.tsx';
import { RelativeTime } from '@/components/shared/RelativeTime.tsx';
import { StatusBadge } from '@/components/shared/StatusBadge.tsx';
import { Button } from '@/components/ui/button.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx';
import { Kbd } from '@/components/ui/kbd.tsx';
import { Hint } from '@/components/ui/tooltip.tsx';
import { toAppError } from '@/lib/api/errors.ts';
import { formatDuration } from '@/lib/format/time.ts';
import { ICONS } from '@/lib/icons.ts';
import { useServerNow } from '@/lib/server-now.ts';
import { sessionDisplayState } from '@/lib/status-registry.ts';
import { useSessionMutations } from '../api.ts';
import { deleteConfirm, terminateConfirm } from '../confirm-copy.ts';
import type { SessionTab } from '../detail-search.ts';
import { ArchiveLabel } from '../list/SessionRowActions.tsx';
import { browserLabel, coarseDuration } from '../session-format.ts';
import { downloadExport, EXPORT_FORMAT_IDS, EXPORT_FORMATS, type ExportFormat } from './export.ts';
import { traceViewerHint, useTraceViewer } from './use-trace-viewer.ts';

/** Props. */
export interface SessionHeaderProps {
  readonly detail: SessionDetail;
  readonly live: boolean;
  /** Active tab: Files & trace carries its own "Open trace viewer", so the header drops it there. */
  readonly tab?: SessionTab;
  readonly onToggleLive: () => void;
}

/**
 * The session id is its own copy control: click (or Enter) copies it and the tooltip confirms. No
 * separate icon, so nothing reserves space beside it in the meta line.
 */
function CopyId({ id }: { readonly id: string }) {
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => (timer.current === null ? undefined : clearTimeout(timer.current)), []);
  return (
    <Hint
      label={
        copied === 'copied' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy session id'
      }
    >
      <button
        type="button"
        aria-label={`Copy session id ${id}`}
        className="focus-ring relative inline-flex min-w-0 cursor-pointer items-center rounded-sm font-mono text-sm text-muted-foreground decoration-dotted underline-offset-4 after:absolute after:inset-x-0 after:-inset-y-2.5 hover:text-foreground hover:underline"
        onClick={() => {
          void copyText(id).then((ok) => {
            setCopied(ok ? 'copied' : 'failed');
            if (timer.current !== null) clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied('idle'), 1500);
          });
        }}
      >
        <span className="min-w-0 truncate">{id}</span>
      </button>
    </Hint>
  );
}

/** Header. */
export function SessionHeader({ detail, live, tab, onToggleLive }: SessionHeaderProps) {
  const { session } = detail;
  const id = session.session_id;
  const api = useApi();
  const confirm = useConfirm();
  const toast = useToast();
  const navigate = useNavigate();
  const now = useServerNow();
  const m = useSessionMutations(id);
  const trace = useTraceViewer(id);
  const hint = traceViewerHint(detail);
  const archived = session.archived_at !== null;
  const browser = browserLabel(session);
  const ended = session.closed_at ?? now;
  const More = ICONS.more;
  const LiveIcon = ICONS.live;

  const onTerminate = async () => {
    if (!(await confirm(terminateConfirm(1, session.slug)))) return;
    await m.terminate.mutateAsync();
    toast.success({ title: `Terminated ${session.slug}` });
  };
  const onDelete = async () => {
    if (!(await confirm(deleteConfirm(1, session.slug)))) return;
    await m.remove.mutateAsync();
    toast.success({ title: `Deleted ${session.slug}` });
    void navigate({ to: '/sessions' });
  };
  const onExport = async (format: ExportFormat) => {
    try {
      const { truncated } = await downloadExport(
        api.url('exportSession', { session_id: id }),
        session.slug,
        format,
      );
      if (truncated) toast.warning({ title: 'Export truncated at 100,000 rows' });
    } catch (error) {
      toast.fromError(toAppError(error), 'Export failed');
    }
  };

  // Separators are drawn before each item and clipped at the start of a line, so a wrap never
  // leaves a dangling "·". The age is coarse so the line does not reflow every second.
  const meta = (
    <span className="-my-1 flex w-full min-w-0 overflow-hidden py-1">
      <span className="-ml-5 flex min-w-0 flex-wrap items-center gap-y-1 [&>*]:relative [&>*]:pl-5 [&>*]:before:absolute [&>*]:before:left-2 [&>*]:before:text-subtle-foreground [&>*]:before:content-['·']">
        <span className="inline-flex max-w-full min-w-0">
          <CopyId id={id} />
        </span>
        <span>{session.owner}</span>
        {browser !== null ? <span>{browser}</span> : null}
        <span className="inline-flex items-center gap-1">
          Started <RelativeTime at={session.created_at} className="min-w-0" />
        </span>
        <span className="tabular-nums">
          {session.live ? 'Running for ' : 'Ran for '}
          {session.live
            ? coarseDuration(ended - session.created_at)
            : formatDuration(Math.max(0, ended - session.created_at))}
        </span>
      </span>
    </span>
  );

  const actions = (
    <>
      {session.live ? (
        <Hint label={live ? 'Hide the live view' : 'Watch the browser live'} shortcut="L">
          <Button type="button" variant="outline" aria-pressed={live} onClick={onToggleLive}>
            <LiveIcon aria-hidden="true" />
            Live
            <Kbd className="-mr-1 hidden lg:inline-flex">L</Kbd>
          </Button>
        </Hint>
      ) : hint.enabled && tab !== 'files' ? (
        <Button
          type="button"
          variant="outline"
          disabled={trace.opening}
          onClick={() => void trace.open()}
        >
          Open trace viewer
        </Button>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button type="button" variant="ghost" size="icon" aria-label="More session actions" />
          }
        >
          <More aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-52">
          <DropdownMenuItem disabled={!hint.enabled} onClick={() => void trace.open()}>
            <ICONS.external aria-hidden="true" />
            Open trace viewer
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!detail.trace.enabled || session.live}
            render={<a href={trace.downloadUrl} download={`${session.slug}-trace.zip`} />}
          >
            <ICONS.download aria-hidden="true" />
            Download trace.zip
          </DropdownMenuItem>
          {EXPORT_FORMAT_IDS.map((format) => (
            <DropdownMenuItem key={format} onClick={() => void onExport(format)}>
              <ICONS.download aria-hidden="true" />
              Export activity ({EXPORT_FORMATS[format].label})
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem
            onClick={() => {
              void copyText(id).then((ok) => {
                if (ok) toast.success({ title: 'Session id copied' });
              });
            }}
          >
            <ICONS.copy aria-hidden="true" />
            Copy session id
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={session.live && !archived}
            onClick={() => void (archived ? m.unarchive.mutateAsync() : m.archive.mutateAsync())}
          >
            <ICONS.archive aria-hidden="true" />
            <ArchiveLabel archived={archived} live={session.live} />
          </DropdownMenuItem>
          {session.live ? (
            <DropdownMenuItem variant="destructive" onClick={() => void onTerminate()}>
              <ICONS.stop aria-hidden="true" />
              Terminate…
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem variant="destructive" onClick={() => void onDelete()}>
            <ICONS.delete aria-hidden="true" />
            Delete…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );

  return (
    <PageHeader
      title={session.slug}
      badge={<StatusBadge domain="session" value={sessionDisplayState(session)} />}
      meta={meta}
      actions={actions}
    />
  );
}

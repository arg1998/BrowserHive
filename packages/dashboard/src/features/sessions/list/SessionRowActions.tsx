/** @module features/sessions/list/SessionRowActions — trailing row actions: "Open live" (live rows) and a menu with icons — Open, Open live, Copy id, Archive/Unarchive, Terminate… (live only), Delete… ; a disabled Archive says why */
import type { SessionSummary } from '@browserhive/contracts/http';
import { Link, useNavigate } from '@tanstack/react-router';
import { useConfirm } from '@/app/providers/ConfirmProvider.tsx';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { copyText } from '@/components/shared/CopyButton.tsx';
import { useRowControlTabIndex } from '@/components/shared/row-context.ts';
import { Button, buttonVariants } from '@/components/ui/button.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx';
import { Hint } from '@/components/ui/tooltip.tsx';
import { ICONS } from '@/lib/icons.ts';
import { useSessionMutations } from '../api.ts';
import { deleteConfirm, terminateConfirm } from '../confirm-copy.ts';

/** Props. */
export interface SessionRowActionsProps {
  readonly session: SessionSummary;
  /** Card layout: menu only. */
  readonly compact?: boolean;
}

/** Archive item text; a live session says why it cannot be archived yet. */
export function ArchiveLabel({
  archived,
  live,
}: {
  readonly archived: boolean;
  readonly live: boolean;
}) {
  if (archived) return <>Unarchive</>;
  if (!live) return <>Archive</>;
  return (
    <span className="flex flex-col">
      Archive
      <span className="text-xs text-muted-foreground">Available once the session closes</span>
    </span>
  );
}

/** Row actions. */
export function SessionRowActions({ session, compact = false }: SessionRowActionsProps) {
  const confirm = useConfirm();
  const toast = useToast();
  const navigate = useNavigate();
  const rowTabIndex = useRowControlTabIndex();
  const mutations = useSessionMutations(session.session_id);
  const busy =
    mutations.terminate.isPending ||
    mutations.archive.isPending ||
    mutations.unarchive.isPending ||
    mutations.remove.isPending;
  const More = ICONS.more;
  const Live = ICONS.live;
  const archived = session.archived_at !== null;
  const id = session.session_id;

  const onTerminate = async () => {
    if (!(await confirm(terminateConfirm(1, session.slug)))) return;
    await mutations.terminate.mutateAsync();
    toast.success({ title: `Terminated ${session.slug}` });
  };
  const onArchive = async () => {
    if (archived) {
      await mutations.unarchive.mutateAsync();
      toast.success({ title: `Unarchived ${session.slug}` });
    } else {
      await mutations.archive.mutateAsync();
      toast.success({ title: `Archived ${session.slug}` });
    }
  };
  const onDelete = async () => {
    if (!(await confirm(deleteConfirm(1, session.slug)))) return;
    const result = await mutations.remove.mutateAsync();
    toast.success({
      title: `Deleted ${session.slug}`,
      description: `${result.deleted.rows} rows removed.`,
    });
  };

  return (
    <span className="inline-flex items-center gap-0.5">
      {session.live && !compact ? (
        <Hint label="Open live view">
          <Link
            to="/sessions/$id"
            params={{ id }}
            search={{ live: 1 }}
            aria-label={`Open live view of ${session.slug}`}
            tabIndex={rowTabIndex}
            className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
          >
            <Live aria-hidden="true" />
          </Link>
        </Hint>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Actions for ${session.slug}`}
              disabled={busy}
            />
          }
        >
          <More aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-48">
          <DropdownMenuItem onClick={() => void navigate({ to: '/sessions/$id', params: { id } })}>
            <ICONS.arrowUpRight aria-hidden="true" />
            Open
          </DropdownMenuItem>
          {session.live ? (
            <DropdownMenuItem
              onClick={() =>
                void navigate({ to: '/sessions/$id', params: { id }, search: { live: 1 } })
              }
            >
              <Live aria-hidden="true" />
              Open live view
            </DropdownMenuItem>
          ) : null}
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
          <DropdownMenuItem disabled={session.live && !archived} onClick={() => void onArchive()}>
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
    </span>
  );
}

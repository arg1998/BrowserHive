/** @module features/sessions/list/SessionsBulk — bulk bar wiring: archive/unarchive, terminate (only when a selected session is live, and only the live ones), delete over `POST /sessions/bulk` with confirm dialogs, select-all-matching and the per-item result dialog */
import {
  BULK_SESSIONS_MAX,
  type BulkSessionAction,
  type BulkSessionsResponse,
} from '@browserhive/contracts/http';
import { useState } from 'react';
import { useApi } from '@/app/providers/AuthProvider.tsx';
import { useConfirm } from '@/app/providers/ConfirmProvider.tsx';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { type BulkAction, BulkBar } from '@/components/shared/bulk-bar.tsx';
import { toAppError } from '@/lib/api/errors.ts';
import { useBulkSessionsMutation } from '../api.ts';
import { archiveConfirm, deleteConfirm, terminateConfirm } from '../confirm-copy.ts';
import { type SessionsSearch, toSessionsQuery } from '../search.ts';
import { BulkResultDialog } from './BulkResultDialog.tsx';

/** Props. */
export interface SessionsBulkProps {
  readonly search: SessionsSearch;
  /** Selected session ids → whether each is live. */
  readonly selection: ReadonlyMap<string, boolean>;
  readonly total: number | undefined;
  readonly onSelection: (selection: ReadonlyMap<string, boolean>) => void;
}

/** Bulk bar + result dialog. */
export function SessionsBulk({ search, selection, total, onSelection }: SessionsBulkProps) {
  const api = useApi();
  const confirm = useConfirm();
  const toast = useToast();
  const bulk = useBulkSessionsMutation();
  const [result, setResult] = useState<{
    action: BulkSessionAction;
    response: BulkSessionsResponse;
  } | null>(null);
  const [selectingAll, setSelectingAll] = useState(false);
  const ids = [...selection.keys()];
  const liveIds = ids.filter((id) => selection.get(id) === true);
  const archivedView = search.view === 'archived';

  const run = async (action: BulkSessionAction) => {
    const target = (action === 'terminate' ? liveIds : ids).slice(0, BULK_SESSIONS_MAX);
    if (target.length < ids.length) {
      toast.warning({
        title: `Only the first ${BULK_SESSIONS_MAX} selected sessions are processed`,
        description: 'Bulk actions take at most 100 sessions per call. Run it again for the rest.',
      });
    }
    const options =
      action === 'delete'
        ? deleteConfirm(target.length)
        : action === 'terminate'
          ? terminateConfirm(target.length)
          : archiveConfirm(action, target.length);
    if (!(await confirm(options))) return;
    const response = await bulk.mutateAsync({ action, ids: target });
    setResult({ action, response });
    const done = new Set<string>(response.results.filter((r) => r.ok).map((r) => r.session_id));
    onSelection(new Map([...selection].filter(([id]) => !done.has(id))));
  };

  const selectAllMatching = async () => {
    setSelectingAll(true);
    try {
      const page = await api.listSessions({
        query: { ...toSessionsQuery(search, undefined), limit: BULK_SESSIONS_MAX },
      });
      onSelection(new Map(page.data.map((s) => [s.session_id, s.live] as const)));
      if (page.page.next_cursor !== null) {
        toast.info({
          title: `Selected the first ${page.data.length} matching sessions`,
          description: 'Bulk actions are capped at 100 sessions per call.',
        });
      }
    } catch (error) {
      toast.fromError(toAppError(error));
    } finally {
      setSelectingAll(false);
    }
  };

  const actions: BulkAction[] = [
    archivedView
      ? {
          id: 'unarchive',
          label: 'Unarchive',
          icon: 'archive',
          onClick: () => void run('unarchive'),
        }
      : { id: 'archive', label: 'Archive', icon: 'archive', onClick: () => void run('archive') },
    ...(liveIds.length > 0
      ? [
          {
            id: 'terminate',
            label: liveIds.length === ids.length ? 'Terminate' : `Terminate ${liveIds.length} live`,
            icon: 'stop' as const,
            danger: true,
            onClick: () => void run('terminate'),
          },
        ]
      : []),
    {
      id: 'delete',
      label: 'Delete…',
      icon: 'delete',
      danger: true,
      onClick: () => void run('delete'),
    },
  ];

  return (
    <>
      <BulkBar
        count={selection.size}
        {...(total !== undefined && { total })}
        actions={actions}
        onSelectAll={() => void selectAllMatching()}
        onClear={() => onSelection(new Map())}
        busy={bulk.isPending || selectingAll}
        {...(bulk.isPending && { progress: 0.5 })}
      />
      <BulkResultDialog result={result} onClose={() => setResult(null)} />
    </>
  );
}

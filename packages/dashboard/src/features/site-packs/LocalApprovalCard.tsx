/** @module features/site-packs/LocalApprovalCard — a local file waiting for approval (spec 13 §10.5): its path and state, the classified approved-versus-current diff (a below-floor refusal explained in place), and **Approve** behind a confirmation naming the SHA-256. The hash approved is the one of the diff on screen (`to.sha256` of that response, review S-M3): Approve waits while the diff loads or refreshes, and when the file changed since the list was read */
import type { SitePackView } from '@browserhive/contracts/http';
import { useId } from 'react';
import { useConfirm } from '@/app/providers/ConfirmProvider.tsx';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { Button } from '@/components/ui/button.tsx';
import { toAppError } from '@/lib/api/errors.ts';
import { ICONS } from '@/lib/icons.ts';
import { useSitePackActions, useSitePackDiff } from './api.ts';
import { ClassificationChip } from './ClassificationChip.tsx';
import { approveLocalConfirm } from './confirm-copy.ts';
import { DiffPanel } from './DiffView.tsx';
import { FloorRefusal, floorRefusalOf } from './FloorRefusal.tsx';
import { iso } from './model.ts';
import { LocalStatePill, ShaText } from './PackBits.tsx';
import { UpdateFrame } from './UpdateFrame.tsx';

/** The hash Approve may send: the shown diff's, once it is settled and matches the file now listed; else `null`. */
export function reviewedSha(
  diff: { readonly to: { readonly sha256: string } } | undefined,
  fetching: boolean,
  listed: string | null,
): string | null {
  if (diff === undefined || fetching) return null;
  return listed === null || diff.to.sha256 === listed ? diff.to.sha256 : null;
}

/** A local file that needs approval (not yet approved, or changed since approval). */
export function LocalApprovalCard({ pack }: { readonly pack: SitePackView }) {
  const headingId = useId();
  const actions = useSitePackActions(pack.pack_id);
  const confirm = useConfirm();
  const toast = useToast();
  const diff = useSitePackDiff(pack.pack_id, 'local', pack.local !== null);
  const local = pack.local;
  if (local === null) return null;
  const sha = reviewedSha(diff.data, diff.isFetching, local.sha256);
  const refusal = floorRefusalOf(
    actions.approveLocal.error === null ? null : toAppError(actions.approveLocal.error),
  );
  const stale = diff.data !== undefined && !diff.isFetching && sha === null;
  const onApprove = async () => {
    if (sha === null) return;
    if (!(await confirm(approveLocalConfirm(pack, local.path, sha)))) return;
    actions.approveLocal.mutate(sha, {
      onSuccess: () => toast.success({ title: `${iso(pack.title)}: local file approved` }),
    });
  };
  return (
    <UpdateFrame
      pack={pack}
      headingId={headingId}
      heading="local file"
      badge={
        <span className="flex flex-wrap items-center gap-1.5">
          <LocalStatePill local={local} />
          {diff.data !== undefined && diff.data.from !== null ? (
            <ClassificationChip classification={diff.data.classification} />
          ) : null}
        </span>
      }
      facts={
        <>
          <bdi className="font-mono text-xs [overflow-wrap:anywhere]">{local.path}</bdi>
          {sha !== null ? <ShaText sha256={sha} /> : null}
          {local.state === 'changed' ? (
            <span>The approved content keeps applying until you approve this one.</span>
          ) : (
            <span>Nothing of it applies until you approve it.</span>
          )}
          {stale ? (
            <span className="text-warn-text">
              The file changed while you were looking: reload the changes before approving.
            </span>
          ) : null}
        </>
      }
      diff={
        <>
          {refusal !== null ? <FloorRefusal refusal={refusal} title={pack.title} /> : null}
          <DiffPanel query={diff} />
        </>
      }
      actions={
        <>
          {stale ? (
            <Button type="button" size="sm" variant="outline" onClick={() => void diff.refetch()}>
              <ICONS.refresh aria-hidden="true" />
              Reload the changes
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            disabled={sha === null || actions.approveLocal.isPending}
            onClick={() => void onApprove()}
          >
            <ICONS.check aria-hidden="true" />
            Approve…
          </Button>
        </>
      }
    />
  );
}

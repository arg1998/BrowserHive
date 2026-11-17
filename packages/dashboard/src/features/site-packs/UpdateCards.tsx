/** @module features/site-packs/UpdateCards — a pending version of a followed pack in Updates available (spec 13 §10.6, §11.4): from → to, provenance, release and notes, the field-level diff unclassified, **Apply** behind a confirmation, **Reject**, **Pin**. A local file waiting for approval is `LocalApprovalCard` */
import type { SitePackPending, SitePackView } from '@browserhive/contracts/http';
import { useId } from 'react';
import { useConfirm } from '@/app/providers/ConfirmProvider.tsx';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { Chip } from '@/components/shared/Chip.tsx';
import { Button } from '@/components/ui/button.tsx';
import { formatBytes } from '@/lib/format/bytes.ts';
import { ICONS } from '@/lib/icons.ts';
import { useSitePackActions } from './api.ts';
import { applyConfirm } from './confirm-copy.ts';
import { DiffLoader } from './DiffView.tsx';
import { iso, provenanceText } from './model.ts';
import { ShaText } from './PackBits.tsx';
import { UpdateFrame } from './UpdateFrame.tsx';

/** A pending version of a followed pack. */
export function PendingUpdateCard({
  pack,
  pending,
}: {
  readonly pack: SitePackView;
  readonly pending: SitePackPending;
}) {
  const headingId = useId();
  const actions = useSitePackActions(pack.pack_id);
  const confirm = useConfirm();
  const toast = useToast();
  const from = pack.approved?.version ?? null;
  const busy = actions.apply.isPending || actions.reject.isPending || actions.pin.isPending;
  const onApply = async () => {
    if (!(await confirm(applyConfirm(pack, pending.version)))) return;
    actions.apply.mutate(pending.version, {
      onSuccess: () => toast.success({ title: `${iso(pack.title)} v${pending.version} applied` }),
    });
  };
  return (
    <UpdateFrame
      pack={pack}
      headingId={headingId}
      heading={from === null ? `v${pending.version}` : `v${from} → v${pending.version}`}
      badge={<Chip tone="accent">Update</Chip>}
      facts={
        <>
          <bdi>{provenanceText(pending.provenance, pending.source)}</bdi>
          {pending.released !== null || pending.size !== null ? (
            <span>
              {[
                pending.released === null ? null : `Released ${pending.released}`,
                pending.size === null ? null : formatBytes(pending.size),
              ]
                .filter((s) => s !== null)
                .join(' · ')}
            </span>
          ) : null}
          {pending.notes !== null ? (
            <bdi className="text-foreground text-pretty">{pending.notes}</bdi>
          ) : null}
          {pending.sha256 !== null ? <ShaText sha256={pending.sha256} /> : null}
        </>
      }
      diff={<DiffLoader packId={pack.pack_id} to={pending.version} />}
      actions={
        <>
          {from !== null ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() =>
                actions.pin.mutate(from, {
                  onSuccess: () =>
                    toast.success({ title: `${iso(pack.title)} pinned at v${from}` }),
                })
              }
            >
              <ICONS.pin aria-hidden="true" />
              Pin v{from}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() =>
              actions.reject.mutate(pending.version, {
                onSuccess: () =>
                  toast.success({ title: `${iso(pack.title)} v${pending.version} rejected` }),
              })
            }
          >
            Reject
          </Button>
          <Button type="button" size="sm" disabled={busy} onClick={() => void onApply()}>
            <ICONS.check aria-hidden="true" />
            Apply…
          </Button>
        </>
      }
    />
  );
}

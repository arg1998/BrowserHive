/** @module features/site-packs/UpdateCards — the cards of the Updates available section (spec 13 §10.5, §10.6, §11.4): a pending version of a followed pack (from → to, provenance, release and notes, the field-level diff unclassified, **Apply** behind a confirmation, **Reject**, **Pin**) and a local file that needs approval (its path and state, the approved-versus-current diff, **Approve** behind a confirmation that names the SHA-256) */
import type { SitePackPending, SitePackView } from '@browserhive/contracts/http';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useId } from 'react';
import { useConfirm } from '@/app/providers/ConfirmProvider.tsx';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { Chip } from '@/components/shared/Chip.tsx';
import { Button } from '@/components/ui/button.tsx';
import { formatBytes } from '@/lib/format/bytes.ts';
import { ICONS } from '@/lib/icons.ts';
import { useSitePackActions } from './api.ts';
import { applyConfirm, approveLocalConfirm } from './confirm-copy.ts';
import { DiffLoader } from './DiffView.tsx';
import { provenanceText } from './model.ts';
import { LocalStatePill, ShaText } from './PackBits.tsx';

/** The frame both cards share: heading row, facts, the diff, the actions. */
function UpdateFrame({
  pack,
  headingId,
  heading,
  badge,
  facts,
  diff,
  actions,
}: {
  readonly pack: SitePackView;
  readonly headingId: string;
  readonly heading: string;
  readonly badge: ReactNode;
  readonly facts: ReactNode;
  readonly diff: ReactNode;
  readonly actions: ReactNode;
}) {
  return (
    <article
      aria-labelledby={headingId}
      data-pack={pack.pack_id}
      className="flex min-w-0 flex-col rounded-xl border bg-card shadow-xs dark:shadow-none"
    >
      <div className="flex min-w-0 flex-col gap-3 p-5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
          <h3
            id={headingId}
            tabIndex={-1}
            className="text-base font-semibold focus-ring rounded-sm"
          >
            <Link
              to="/site-packs/$id"
              params={{ id: pack.pack_id }}
              className="hover:underline underline-offset-4 focus-ring rounded-sm"
            >
              {pack.title}
            </Link>{' '}
            <span className="font-normal text-muted-foreground">{heading}</span>
          </h3>
          {badge}
        </div>
        <div className="flex min-w-0 flex-col gap-1 text-sm text-muted-foreground">{facts}</div>
        {diff}
      </div>
      <div className="mt-auto flex flex-wrap items-center justify-end gap-2 border-t bg-muted/40 px-5 py-2.5 dark:bg-white/[0.02]">
        {actions}
      </div>
    </article>
  );
}

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
      onSuccess: () => toast.success({ title: `${pack.title} v${pending.version} applied` }),
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
          <span>{provenanceText(pending.provenance, pending.source)}</span>
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
            <span className="text-foreground text-pretty">{pending.notes}</span>
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
                  onSuccess: () => toast.success({ title: `${pack.title} pinned at v${from}` }),
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
                  toast.success({ title: `${pack.title} v${pending.version} rejected` }),
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

/** A local file that needs approval (not yet approved, or changed since approval). */
export function LocalApprovalCard({ pack }: { readonly pack: SitePackView }) {
  const headingId = useId();
  const actions = useSitePackActions(pack.pack_id);
  const confirm = useConfirm();
  const toast = useToast();
  const local = pack.local;
  if (local === null) return null;
  const sha = local.sha256;
  const onApprove = async () => {
    if (sha === null) return;
    if (!(await confirm(approveLocalConfirm(pack, local.path, sha)))) return;
    actions.approveLocal.mutate(sha, {
      onSuccess: () => toast.success({ title: `${pack.title}: local file approved` }),
    });
  };
  return (
    <UpdateFrame
      pack={pack}
      headingId={headingId}
      heading="local file"
      badge={<LocalStatePill local={local} />}
      facts={
        <>
          <span className="font-mono text-xs [overflow-wrap:anywhere]">{local.path}</span>
          {sha !== null ? <ShaText sha256={sha} /> : null}
          {local.state === 'changed' ? (
            <span>The approved content keeps applying until you approve this one.</span>
          ) : (
            <span>Nothing of it applies until you approve it.</span>
          )}
        </>
      }
      diff={<DiffLoader packId={pack.pack_id} to="local" />}
      actions={
        <Button
          type="button"
          size="sm"
          disabled={sha === null || actions.approveLocal.isPending}
          onClick={() => void onApprove()}
        >
          <ICONS.check aria-hidden="true" />
          Approve…
        </Button>
      }
    />
  );
}

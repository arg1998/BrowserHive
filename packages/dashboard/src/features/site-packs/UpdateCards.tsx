/** @module features/site-packs/UpdateCards — a pending version in Updates available (spec 13 §10.6, §11.4): from → to, provenance ("browserhive.ai registry · key … · signature verified · index …", "Imported file …", "Bundled with BrowserHive …"), release date, size and the publisher's notes as plain text. A listed version not downloaded yet (`available`) offers **Download & review** (disabled with its reason without a fresh index) and says what downloading reveals; a downloaded one shows its classification chip and the classified field-level diff, **Apply** behind a confirmation whose copy follows the classification (a below-floor refusal explained in place, `FloorRefusal`), **Reject**, **Pin**, and a box for Apply selected. A revoked version kept in force without a fallback is `RevokedKeptCard`; a local file waiting for approval is `LocalApprovalCard`. Every action reports back (`onDone`) so focus can return to the card */
import type {
  SitePackPending,
  SitePackRegistryStatus,
  SitePackView,
} from '@browserhive/contracts/http';
import { useId } from 'react';
import { useConfirm } from '@/app/providers/ConfirmProvider.tsx';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { Chip } from '@/components/shared/Chip.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Checkbox } from '@/components/ui/checkbox.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { toAppError } from '@/lib/api/errors.ts';
import { formatBytes } from '@/lib/format/bytes.ts';
import { ICONS } from '@/lib/icons.ts';
import { useSitePackActions } from './api.ts';
import { ClassificationChip } from './ClassificationChip.tsx';
import { applyConfirm } from './confirm-copy.ts';
import { DiffLoader } from './DiffView.tsx';
import { FloorRefusal, floorRefusalOf } from './FloorRefusal.tsx';
import { iso, provenanceText } from './model.ts';
import { ShaText } from './PackBits.tsx';
import { TurnOffButton } from './PackControls.tsx';
import { WithReason } from './RegistryControls.tsx';
import { DOWNLOAD_REVEALS, downloadBlocked } from './registry-model.ts';
import { UpdateFrame } from './UpdateFrame.tsx';

/** What a card's action did (focus goes back to the card, or to the next one when it left). */
export type CardAction = 'download' | 'apply' | 'reject' | 'pin' | 'off';

/** The card's place in Apply selected: offered only for downloaded versions. */
export interface CardSelection {
  readonly selected: boolean;
  readonly onChange: (selected: boolean) => void;
}

/** Released · size, when known. */
function releaseLine(pending: SitePackPending): string | null {
  const parts = [
    pending.released === null ? null : `Released ${pending.released}`,
    pending.size === null ? null : formatBytes(pending.size),
  ].filter((s) => s !== null);
  return parts.length === 0 ? null : parts.join(' · ');
}

/** The publisher's notes, as plain text (never a link). */
function Notes({ notes }: { readonly notes: string }) {
  return (
    <div className="mt-1 flex min-w-0 flex-col gap-0.5 rounded-lg bg-muted/60 px-3 py-2 dark:bg-white/[0.03]">
      <span className="text-xs font-medium text-muted-foreground">Publisher’s notes</span>
      <bdi className="text-sm whitespace-pre-line text-foreground text-pretty [overflow-wrap:anywhere]">
        {notes}
      </bdi>
    </div>
  );
}

/** A version not downloaded yet: what Download & review does and reveals. */
function NotDownloaded() {
  return (
    <div className="flex min-w-0 gap-3 rounded-lg border border-dashed px-4 py-3 text-sm">
      <ICONS.download aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-foreground">
          Not downloaded yet. Download & review fetches it, checks it against the signed index and
          shows every field it changes before you decide.
        </p>
        <p className="text-muted-foreground text-pretty">{DOWNLOAD_REVEALS}</p>
      </div>
    </div>
  );
}

/** A pending version of a followed pack. */
export function PendingUpdateCard({
  pack,
  pending,
  status,
  selection,
  onDone,
}: {
  readonly pack: SitePackView;
  readonly pending: SitePackPending;
  readonly status?: SitePackRegistryStatus | undefined;
  readonly selection?: CardSelection | undefined;
  readonly onDone?: ((action: CardAction) => void) | undefined;
}) {
  const headingId = useId();
  const selectId = useId();
  const actions = useSitePackActions(pack.pack_id);
  const confirm = useConfirm();
  const toast = useToast();
  const from = pack.approved?.version ?? null;
  const available = pending.state === 'available';
  const classification = pending.classification ?? 'unclassified';
  const revoked = classification === 'revoked';
  const refusal = floorRefusalOf(
    actions.apply.error === null ? null : toAppError(actions.apply.error),
  );
  const busy =
    actions.apply.isPending ||
    actions.reject.isPending ||
    actions.pin.isPending ||
    actions.download.isPending;
  const blocked = available ? downloadBlocked(status) : null;
  const name = iso(pack.title);
  const onApply = async () => {
    if (!(await confirm(applyConfirm(pack, pending.version, classification)))) return;
    actions.apply.mutate(pending.version, {
      onSuccess: () => {
        toast.success({ title: `${name} v${pending.version} applied` });
        onDone?.('apply');
      },
    });
  };
  const onDownload = () =>
    actions.download.mutate(pending.version, {
      onSuccess: (result) => {
        toast.success({
          title: `${name} v${pending.version} downloaded`,
          description: `Verified against the signed index. ${result.diff.changes.length} ${result.diff.changes.length === 1 ? 'field changes' : 'fields change'}: review them before you apply it.`,
        });
        onDone?.('download');
      },
    });
  const release = releaseLine(pending);
  return (
    <UpdateFrame
      pack={pack}
      headingId={headingId}
      heading={from === null ? `v${pending.version}` : `v${from} → v${pending.version}`}
      badge={
        <span className="flex flex-wrap items-center gap-1.5">
          {revoked || from === null ? null : <Chip tone="accent">Update</Chip>}
          {available ? (
            <Chip tone="muted">Not downloaded</Chip>
          ) : (
            <ClassificationChip classification={classification} />
          )}
        </span>
      }
      facts={
        <>
          {revoked ? (
            <span className="text-foreground text-pretty">
              The publisher revoked v{from ?? '?'}, the version in force. It keeps applying until
              you apply this earlier version or reject it.
            </span>
          ) : null}
          <bdi className="[overflow-wrap:anywhere]">
            {provenanceText(pending.provenance, pending.source)}
          </bdi>
          {release !== null ? <span>{release}</span> : null}
          {pending.sha256 !== null ? <ShaText sha256={pending.sha256} /> : null}
          {pending.notes !== null && pending.notes !== '' ? <Notes notes={pending.notes} /> : null}
        </>
      }
      diff={
        available ? (
          <NotDownloaded />
        ) : (
          <>
            {refusal !== null ? (
              <FloorRefusal refusal={refusal} title={pack.title} action="apply" />
            ) : null}
            <DiffLoader packId={pack.pack_id} to={pending.version} />
          </>
        )
      }
      start={
        selection !== undefined && !available ? (
          <span className="flex items-center gap-2 text-sm">
            <Checkbox
              id={selectId}
              checked={selection.selected}
              onCheckedChange={(checked: boolean) => selection.onChange(checked)}
            />
            <label htmlFor={selectId} className="cursor-pointer select-none">
              Select
              <span className="sr-only">
                {' '}
                {pack.title} v{pending.version}
              </span>
            </label>
          </span>
        ) : undefined
      }
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
                  onSuccess: () => {
                    toast.success({ title: `${name} pinned at v${from}` });
                    onDone?.('pin');
                  },
                })
              }
            >
              <ICONS.pin aria-hidden="true" />
              Pin v{from}
            </Button>
          ) : null}
          {available ? (
            <WithReason reason={blocked}>
              <Button
                type="button"
                size="sm"
                disabled={busy || blocked !== null}
                onClick={onDownload}
              >
                {actions.download.isPending ? <Spinner /> : <ICONS.download aria-hidden="true" />}
                Download & review
              </Button>
            </WithReason>
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  actions.reject.mutate(pending.version, {
                    onSuccess: () => {
                      toast.success({ title: `${name} v${pending.version} rejected` });
                      onDone?.('reject');
                    },
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
          )}
        </>
      }
    />
  );
}

/**
 * The publisher revoked the version in force and lists nothing to fall back to (spec 13 §9.7, D52):
 * it stays in force; the operator can turn the pack off or wait for a newer version.
 */
export function RevokedKeptCard({ pack }: { readonly pack: SitePackView }) {
  const headingId = useId();
  const version = pack.approved?.version ?? null;
  return (
    <UpdateFrame
      pack={pack}
      headingId={headingId}
      heading={version === null ? 'revoked' : `v${version}`}
      badge={<ClassificationChip classification="revoked" />}
      facts={
        <>
          <span className="text-foreground text-pretty">
            The publisher revoked v{version ?? '?'}, the version in force, and lists no version to
            fall back to. It keeps applying so its sites stay protected.
          </span>
          <span className="text-pretty">
            Turn the pack off if you no longer trust it: its sites then act as generic sites. A
            newer version from the publisher appears here when one is listed.
          </span>
          {pack.approved !== null ? (
            <bdi className="[overflow-wrap:anywhere]">
              {provenanceText(pack.approved.provenance, pack.approved.source)}
            </bdi>
          ) : null}
        </>
      }
      diff={null}
      actions={<TurnOffButton pack={pack} />}
    />
  );
}

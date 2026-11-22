/** @module features/site-packs/UpdateCards — a pending version in Updates available (spec 13 §10.6, §11.4): from → to (or, for a pack nothing approved yet, what it is compared with: the bundled version first use would approve, or nothing when only the registry lists it), provenance, release date, size and the publisher's notes as printable plain text (review #100 H1), a refused download's reason (L1). A listed version not downloaded yet (`available`) offers **Download & review** (disabled with its reason without a fresh index); a downloaded one shows its classification chip and the classified field-level diff, **Apply** behind a confirmation that lists what to read first and, for a first version, what it brings (M2, L5), **Reject** behind one saying the version is set aside (M4), **Pin** (not for a revoked version, L4), and a box for Apply selected. A revoked version kept in force without a fallback is `RevokedKeptCard`; a local file waiting for approval is `LocalApprovalCard`. Buttons stay focusable while an action runs; focus after an action is the scope's (`decision-focus`, M5) */
import type {
  SitePackPending,
  SitePackRegistryStatus,
  SitePackView,
} from '@browserhive/contracts/http';
import { useId } from 'react';
import { useConfirm } from '@/app/providers/ConfirmProvider.tsx';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { Chip } from '@/components/shared/Chip.tsx';
import { Plain } from '@/components/shared/Plain.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Checkbox } from '@/components/ui/checkbox.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { toAppError } from '@/lib/api/errors.ts';
import { formatBytes } from '@/lib/format/bytes.ts';
import { printable } from '@/lib/format/printable.ts';
import { ICONS } from '@/lib/icons.ts';
import { useRegistryName, useSitePackActions, useSitePackDiff } from './api.ts';
import { ClassificationChip } from './ClassificationChip.tsx';
import { applyConfirm, rejectConfirm } from './confirm-copy.ts';
import { DiffLoader } from './DiffView.tsx';
import { focusElement, useDecisionFocus } from './decision-focus.tsx';
import { FloorRefusal, floorRefusalOf } from './FloorRefusal.tsx';
import { iso, provenanceText } from './model.ts';
import { ShaText } from './PackBits.tsx';
import { TurnOffButton } from './PackControls.tsx';
import { WithReason } from './RegistryControls.tsx';
import { downloadBlocked } from './registry-model.ts';
import { UpdateFrame } from './UpdateFrame.tsx';

/** The card's place in Apply selected: offered only for downloaded versions. */
export interface CardSelection {
  readonly selected: boolean;
  readonly onChange: (selected: boolean) => void;
}

/** Released · size, when known. */
function releaseLine(pending: SitePackPending): string | null {
  const parts = [
    pending.released === null ? null : `Released ${printable(pending.released)}`,
    pending.size === null ? null : formatBytes(pending.size),
  ].filter((s) => s !== null);
  return parts.length === 0 ? null : parts.join(' · ');
}

/** The publisher's notes, as printable plain text (never a link, never bidi controls). */
function Notes({ notes }: { readonly notes: string }) {
  return (
    <div className="mt-1 flex min-w-0 flex-col gap-0.5 rounded-lg bg-muted/60 px-3 py-2 dark:bg-white/[0.03]">
      <span className="text-xs font-medium text-muted-foreground">Publisher’s notes</span>
      <Plain
        multiline
        className="text-sm whitespace-pre-line text-foreground text-pretty [overflow-wrap:anywhere]"
      >
        {notes}
      </Plain>
    </div>
  );
}

/** A version not downloaded yet: what Download & review does (what it reveals is said once, above the cards). */
function NotDownloaded() {
  return (
    <div className="flex min-w-0 gap-3 rounded-lg border border-dashed px-4 py-3 text-sm">
      <ICONS.download aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <p className="min-w-0 text-foreground text-pretty">
        Not downloaded yet. Download & review fetches it, checks it against the signed index and
        shows every field it changes before you decide.
      </p>
    </div>
  );
}

/** What the version is compared with, for a pack nothing approved yet (review #100 M2). */
export function comparedWithOf(
  pack: SitePackView,
  pending: SitePackPending,
): { readonly version: number; readonly source: string } | null | undefined {
  if (pack.approved !== null) return undefined;
  if (pending.from !== undefined) return pending.from;
  return pack.offer === null ? null : { version: pack.offer.version, source: pack.offer.source };
}

/** A pending version of a followed pack (or any pending version, on the pack's page). */
export function PendingUpdateCard({
  pack,
  pending,
  status,
  selection,
  decisionKey,
}: {
  readonly pack: SitePackView;
  readonly pending: SitePackPending;
  readonly status?: SitePackRegistryStatus | undefined;
  readonly selection?: CardSelection | undefined;
  /** The decision's key in the focus scope. */
  readonly decisionKey?: string | undefined;
}) {
  const headingId = useId();
  const selectId = useId();
  const actions = useSitePackActions(pack.pack_id);
  const confirm = useConfirm();
  const toast = useToast();
  const focus = useDecisionFocus();
  const registry = useRegistryName();
  const from = pack.approved?.version ?? null;
  const available = pending.state === 'available';
  const classification = pending.classification ?? 'unclassified';
  const revoked = classification === 'revoked';
  const compared = comparedWithOf(pack, pending);
  // The same query the diff below shows (cached): the confirmation names what to read first.
  const diff = useSitePackDiff(pack.pack_id, pending.version, !available);
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
  const key = decisionKey ?? `${pack.pack_id}@${pending.version}`;

  /** Runs an action that may remove the card; focus follows the scope, a failure keeps it here. */
  const leaving = async (run: () => Promise<unknown>, done: () => void) => {
    focus?.start(key);
    try {
      await run();
      done();
    } catch {
      focus?.cancel(key);
    }
  };
  const onApply = async () => {
    if (busy) return;
    const options = applyConfirm(pack, pending.version, classification, {
      diff: diff.data,
      comparedWith: compared,
    });
    if (!(await confirm(options))) return;
    await leaving(
      () => actions.apply.mutateAsync(pending.version),
      () => toast.success({ title: `${name} v${pending.version} applied` }),
    );
  };
  const onReject = async () => {
    if (busy) return;
    if (!(await confirm(rejectConfirm(pack, pending.version)))) return;
    await leaving(
      () => actions.reject.mutateAsync(pending.version),
      () => toast.success({ title: `${name} v${pending.version} set aside` }),
    );
  };
  const onPin = async () => {
    if (busy || from === null) return;
    await leaving(
      () => actions.pin.mutateAsync(from),
      () => toast.success({ title: `${name} pinned at v${from}` }),
    );
  };
  const onDownload = async () => {
    if (busy || blocked !== null) return;
    try {
      const result = await actions.download.mutateAsync(pending.version);
      const n = result.diff.changes.length;
      toast.success({
        title: `${name} v${pending.version} downloaded`,
        description: `Verified against the signed index. ${n} ${n === 1 ? 'field changes' : 'fields change'}: review them before you apply it.`,
      });
      // The card stays: its heading takes focus.
      focusElement(document.getElementById(headingId));
    } catch {
      // A failed download leaves focus on the button (it stays enabled); the toast says why.
    }
  };
  const release = releaseLine(pending);
  const heading = from !== null ? `v${from} → v${pending.version}` : `v${pending.version}`;
  return (
    <UpdateFrame
      pack={pack}
      headingId={headingId}
      heading={heading}
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
          {compared !== undefined ? (
            <span className="text-foreground text-pretty" data-compared="">
              {compared === null
                ? 'Only the registry lists this pack: every field below is new.'
                : `Compared with ${compared.source === 'bundled' ? 'bundled ' : ''}v${compared.version}, which applies on first use.`}
            </span>
          ) : null}
          <Plain className="[overflow-wrap:anywhere]">
            {provenanceText(pending.provenance, pending.source, registry)}
          </Plain>
          {release !== null ? <span>{release}</span> : null}
          {pending.sha256 !== null ? <ShaText sha256={pending.sha256} /> : null}
          {pending.refused !== undefined && pending.refused !== null ? (
            <span className="text-danger-text text-pretty [overflow-wrap:anywhere]" data-refused="">
              Refused: <Plain>{pending.refused.reason}</Plain>{' '}
              <Plain>{pending.refused.detail}</Plain>
            </span>
          ) : null}
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
                {iso(pack.title)} v{pending.version}
              </span>
            </label>
          </span>
        ) : undefined
      }
      actions={
        <>
          {from !== null && !revoked ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-disabled={busy || undefined}
              onClick={() => void onPin()}
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
                disabled={blocked !== null}
                aria-disabled={busy || undefined}
                aria-busy={actions.download.isPending || undefined}
                onClick={() => void onDownload()}
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
                aria-disabled={busy || undefined}
                onClick={() => void onReject()}
              >
                Reject…
              </Button>
              <Button
                type="button"
                size="sm"
                aria-disabled={busy || undefined}
                aria-busy={actions.apply.isPending || undefined}
                onClick={() => void onApply()}
              >
                {actions.apply.isPending ? <Spinner /> : <ICONS.check aria-hidden="true" />}
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
  const registry = useRegistryName();
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
            <Plain className="[overflow-wrap:anywhere]">
              {provenanceText(pack.approved.provenance, pack.approved.source, registry)}
            </Plain>
          ) : null}
        </>
      }
      diff={null}
      actions={<TurnOffButton pack={pack} />}
    />
  );
}

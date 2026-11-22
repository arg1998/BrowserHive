/** @module features/site-packs/UpdatesSection — "Updates available" on top of `/site-packs` (spec 13 §10.6, §11.4): one card per pending version of a followed, unpinned pack (listed and not downloaded, or downloaded and classified), per revoked version kept in force and per local file that needs approval, from the unfiltered catalog so filters never hide a decision; revoked versions first (review #100 L4); what downloading reveals said once under the heading (L13). Downloaded versions can be selected and applied together (**Apply selected**, one after the other, behind a confirmation that lists what relaxes rules). Focus after an action belongs to the page's `DecisionFocusScope` */
import type { SitePackRegistryStatus, SitePackView } from '@browserhive/contracts/http';
import { useState } from 'react';
import { useConfirm } from '@/app/providers/ConfirmProvider.tsx';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { Section } from '@/components/shared/Section.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { ICONS } from '@/lib/icons.ts';
import { useApplySelected } from './api.ts';
import { applySelectedConfirm } from './confirm-copy.ts';
import { useDecisionFocus } from './decision-focus.tsx';
import { LocalApprovalCard } from './LocalApprovalCard.tsx';
import { iso } from './model.ts';
import { DOWNLOAD_REVEALS } from './registry-model.ts';
import { PendingUpdateCard, RevokedKeptCard } from './UpdateCards.tsx';

/** One decision waiting: a pending version, a revoked version kept in force, or a local file. */
export interface Decision {
  readonly key: string;
  readonly pack: SitePackView;
  readonly version: number | 'local' | 'revoked';
}

/** The pending row of a numbered decision. */
function pendingOf(d: Decision) {
  return typeof d.version === 'number'
    ? d.pack.pending.find((p) => p.version === d.version)
    : undefined;
}

/** A revoked version in force is the most urgent decision (L4). */
function isRevoked(d: Decision): boolean {
  return d.version === 'revoked' || pendingOf(d)?.classification === 'revoked';
}

/**
 * The decisions waiting, revoked ones first, then in pack order. `all`: every pending version,
 * followed or pinned or not (a pack's own page).
 */
export function pendingDecisions(
  packs: readonly SitePackView[],
  options: { readonly all?: boolean } = {},
): readonly Decision[] {
  const decisions: Decision[] = packs.flatMap((pack) => {
    const updates =
      options.all === true || (pack.follow.effective && pack.pinned_version === null)
        ? pack.pending.map((p) => ({
            key: `${pack.pack_id}@${p.version}`,
            pack,
            version: p.version,
          }))
        : [];
    const local =
      pack.local !== null && pack.local.state !== 'approved' && pack.local.problem === null
        ? [{ key: `${pack.pack_id}@local`, pack, version: 'local' as const }]
        : [];
    // Revoked and kept with no fallback waiting (a fallback arrives as a pending row classified `revoked`).
    const revoked =
      pack.approved_revoked && !pack.pending.some((p) => p.classification === 'revoked')
        ? [{ key: `${pack.pack_id}@revoked`, pack, version: 'revoked' as const }]
        : [];
    return [...revoked, ...local, ...updates];
  });
  return [...decisions.filter(isRevoked), ...decisions.filter((d) => !isRevoked(d))];
}

/** `true` when a decision is a version not downloaded yet. */
export function hasAvailable(decisions: readonly Decision[]): boolean {
  return decisions.some((d) => pendingOf(d)?.state === 'available');
}

/** The decision cards; also a pack's own page. */
export function DecisionCards({
  decisions,
  status,
  selectable = false,
  selected,
  onSelect,
}: {
  readonly decisions: readonly Decision[];
  readonly status: SitePackRegistryStatus | undefined;
  readonly selectable?: boolean;
  readonly selected?: ReadonlySet<string>;
  readonly onSelect?: (key: string, on: boolean) => void;
}) {
  return (
    <div className="grid min-w-0 gap-4 2xl:grid-cols-2">
      {decisions.map((d) => {
        if (d.version === 'local')
          return (
            <div key={d.key} data-decision={d.key} className="min-w-0">
              <LocalApprovalCard pack={d.pack} />
            </div>
          );
        if (d.version === 'revoked')
          return (
            <div key={d.key} data-decision={d.key} className="min-w-0">
              <RevokedKeptCard pack={d.pack} />
            </div>
          );
        const pending = pendingOf(d);
        if (pending === undefined) return null;
        return (
          <div
            key={d.key}
            data-decision={d.key}
            className="flex min-w-0 flex-col [&>article]:flex-1"
          >
            <PendingUpdateCard
              pack={d.pack}
              pending={pending}
              status={status}
              decisionKey={d.key}
              {...(selectable &&
                selected !== undefined &&
                onSelect !== undefined && {
                  selection: {
                    selected: selected.has(d.key),
                    onChange: (on: boolean) => onSelect(d.key, on),
                  },
                })}
            />
          </div>
        );
      })}
    </div>
  );
}

/** What downloading reveals, said once above the cards (L13). */
export function RevealsNote() {
  return (
    <p className="flex min-w-0 items-start gap-2 text-sm text-muted-foreground text-pretty">
      <ICONS.info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span>{DOWNLOAD_REVEALS}</span>
    </p>
  );
}

/** The section, or nothing when nothing waits. */
export function UpdatesSection({
  packs,
  status,
}: {
  readonly packs: readonly SitePackView[];
  readonly status?: SitePackRegistryStatus | undefined;
}) {
  const decisions = pendingDecisions(packs);
  const confirm = useConfirm();
  const toast = useToast();
  const focus = useDecisionFocus();
  const applySelected = useApplySelected();
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set());
  const downloaded = decisions.filter((d) => pendingOf(d)?.state === 'downloaded');
  // Only cards still downloaded and waiting count; a card that left drops out of the selection.
  const selected = new Set(downloaded.filter((d) => chosen.has(d.key)).map((d) => d.key));
  const selectable = downloaded.length >= 2;
  if (decisions.length === 0) return null;
  const onSelect = (key: string, on: boolean) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  const onApplySelected = async () => {
    if (applySelected.isPending) return;
    const items = downloaded.filter((d) => selected.has(d.key));
    const copy = items.map((d) => ({
      title: d.pack.title,
      from: d.pack.approved?.version ?? null,
      version: typeof d.version === 'number' ? d.version : 0,
      classification: pendingOf(d)?.classification ?? 'unclassified',
    }));
    if (!(await confirm(applySelectedConfirm(copy)))) return;
    for (const d of items) focus?.start(d.key);
    try {
      const { applied, failed } = await applySelected.mutateAsync(
        items.map((d) => ({
          packId: d.pack.pack_id,
          title: d.pack.title,
          version: typeof d.version === 'number' ? d.version : 0,
        })),
      );
      for (const f of failed) focus?.cancel(`${f.item.packId}@${f.item.version}`);
      setChosen(new Set());
      if (failed.length === 0) {
        toast.success({
          title: `Applied ${applied.length} ${applied.length === 1 ? 'version' : 'versions'}`,
        });
        return;
      }
      toast.warning({
        title: `Applied ${applied.length} of ${applied.length + failed.length}`,
        description: failed
          .map(
            (f) =>
              `${iso(f.item.title)} v${f.item.version}: ${f.code === 'SITE_PACK_BELOW_FLOOR' ? 'a template is below its stealth floor, open its card' : f.message}`,
          )
          .join(' · '),
      });
    } catch {
      for (const d of items) focus?.cancel(d.key);
    }
  };
  return (
    <div data-updates="" className="contents">
      <Section
        title="Updates available"
        count={decisions.length}
        description="Nothing here applies until you approve it. Templates keep using the version they have."
        info={
          <p>
            Approving records who approved which version, with its SHA-256 and where it came from. A
            registry version is downloaded only when you press Download & review. A local file is
            approved once per content: a later edit waits here again.
          </p>
        }
        infoDocs="sitePacksApproval"
        {...(selectable && {
          actions:
            selected.size > 0 ? (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setChosen(new Set())}
                >
                  Clear
                </Button>
                <Button
                  type="button"
                  size="sm"
                  aria-disabled={applySelected.isPending || undefined}
                  onClick={() => void onApplySelected()}
                >
                  {applySelected.isPending ? <Spinner /> : <ICONS.checkAll aria-hidden="true" />}
                  Apply {selected.size} selected…
                </Button>
              </>
            ) : (
              <span className="text-sm text-muted-foreground">
                Select downloaded updates to apply several at once
              </span>
            ),
        })}
      >
        {hasAvailable(decisions) ? <RevealsNote /> : null}
        <DecisionCards
          decisions={decisions}
          status={status}
          selectable={selectable}
          selected={selected}
          onSelect={onSelect}
        />
      </Section>
    </div>
  );
}

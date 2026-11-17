/** @module features/site-packs/UpdatesSection — "Updates available" on top of `/site-packs` (spec 13 §10.6, §11.4): one card per pending version of a followed, unpinned pack and per local file that needs approval, from the unfiltered catalog so filters never hide a decision */
import type { SitePackView } from '@browserhive/contracts/http';
import { Section } from '@/components/shared/Section.tsx';
import { LocalApprovalCard, PendingUpdateCard } from './UpdateCards.tsx';

/** The decisions waiting, in pack order. */
export function pendingDecisions(packs: readonly SitePackView[]): readonly {
  readonly key: string;
  readonly pack: SitePackView;
  readonly version: number | 'local';
}[] {
  return packs.flatMap((pack) => {
    const updates =
      pack.follow.effective && pack.pinned_version === null
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
    return [...local, ...updates];
  });
}

/** The section, or nothing when nothing waits. */
export function UpdatesSection({ packs }: { readonly packs: readonly SitePackView[] }) {
  const decisions = pendingDecisions(packs);
  if (decisions.length === 0) return null;
  return (
    <Section
      title="Updates available"
      count={decisions.length}
      description="Nothing here applies until you approve it. Templates keep using the version they have."
      info={
        <p>
          Approving records who approved which version, with its SHA-256 and where it came from. A
          local file is approved once per content: a later edit waits here again.
        </p>
      }
      infoDocs="sitePacksApproval"
    >
      <div className="grid min-w-0 gap-4 2xl:grid-cols-2">
        {decisions.map((d) => {
          if (d.version === 'local') return <LocalApprovalCard key={d.key} pack={d.pack} />;
          const pending = d.pack.pending.find((p) => p.version === d.version);
          return pending === undefined ? null : (
            <PendingUpdateCard key={d.key} pack={d.pack} pending={pending} />
          );
        })}
      </div>
    </Section>
  );
}

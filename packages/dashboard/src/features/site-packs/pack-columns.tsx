/** @module features/site-packs/pack-columns — the packs table of `/site-packs` (spec 13 §11.4) and its card under 768px: Pack (title, domains, Turned off, "Local file overrides vN", why a version was skipped; the source folded in under a 56rem table) · Source (provenance, local-file state) · Approved (version, short SHA-256 with copy, by and when) · Templates · Follow updates · Enabled · the row menu */
import type { SitePackView } from '@browserhive/contracts/http';
import { Chip } from '@/components/shared/Chip.tsx';
import { RelativeTime } from '@/components/shared/RelativeTime.tsx';
import type { DataTableColumn } from '@/components/shared/use-data-table.ts';
import { provenanceText, SKIP_REASON_TEXT } from './model.ts';
import { LocalOverrideBadge, LocalStatePill, ShaText } from './PackBits.tsx';
import { EnabledSwitch, FollowToggle, PackMenu, RevertButton } from './PackControls.tsx';

/** Pack: title (the row link's text) over its domains and what needs care. */
export function PackTitleCell({ pack }: { readonly pack: SitePackView }) {
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="truncate text-base leading-5 font-medium text-foreground decoration-muted-foreground/60 underline-offset-4 group-hover/row:underline">
          {pack.title}
        </span>
        {!pack.enabled ? <Chip tone="muted">Turned off</Chip> : null}
        {pack.local_override ? (
          <LocalOverrideBadge version={pack.approved?.version ?? null} />
        ) : null}
        {pack.pinned_version !== null ? (
          <Chip tone="neutral">
            Pinned at v{pack.pinned_version}
            {pack.pending.length > 0
              ? `, v${pack.pending[pack.pending.length - 1]?.version} available`
              : ''}
          </Chip>
        ) : null}
      </span>
      <span className="font-mono text-sm leading-5 text-muted-foreground [overflow-wrap:anywhere]">
        {pack.domains.join(', ')}
      </span>
      {pack.skipped !== undefined ? (
        <span className="text-sm text-warn-text text-pretty">
          {pack.skipped.version === null ? 'A version' : `v${pack.skipped.version}`} skipped:{' '}
          {SKIP_REASON_TEXT[pack.skipped.reason]}
        </span>
      ) : null}
    </span>
  );
}

/** Source: where the version in force (or on offer) came from, and the local file's state. */
export function PackSourceCell({ pack }: { readonly pack: SitePackView }) {
  const shown = pack.approved ?? pack.offer;
  return (
    <span className="flex min-w-0 flex-col items-start gap-1 text-sm">
      {shown !== null ? (
        <span className="text-pretty [overflow-wrap:anywhere]">
          {provenanceText(shown.provenance, shown.source)}
        </span>
      ) : null}
      {pack.local !== null ? (
        <>
          {shown?.source !== 'local' ? (
            <span className="text-muted-foreground [overflow-wrap:anywhere]">
              Local file {pack.local.path}
            </span>
          ) : null}
          <LocalStatePill local={pack.local} />
          {pack.local.problem !== null ? (
            <span className="text-warn-text text-pretty">Skipped: {pack.local.problem}</span>
          ) : null}
        </>
      ) : null}
    </span>
  );
}

/** Approved: version, short SHA-256, by and when; or what adding a site would approve. */
export function PackApprovedCell({ pack }: { readonly pack: SitePackView }) {
  if (pack.approved === null) {
    return (
      <span className="flex min-w-0 flex-col text-sm text-muted-foreground">
        <span>Not approved yet</span>
        {pack.offer !== null ? (
          <span>v{pack.offer.version} is approved when a template adds the site</span>
        ) : null}
      </span>
    );
  }
  const { approved } = pack;
  return (
    <span className="flex min-w-0 flex-col items-start gap-0.5 text-sm">
      <span className="font-medium tabular-nums">v{approved.version}</span>
      <ShaText sha256={approved.sha256} />
      {approved.at !== null ? (
        <span className="text-muted-foreground">
          {approved.by ?? 'Approved'} · <RelativeTime at={approved.at} className="text-sm" />
        </span>
      ) : null}
    </span>
  );
}

/** Templates using the pack. */
export function usedByText(pack: SitePackView): string {
  const n = pack.used_by.length;
  return n === 0 ? 'No template' : `${n} ${n === 1 ? 'template' : 'templates'}`;
}

/** Column set. */
export function packColumns(): readonly DataTableColumn<SitePackView>[] {
  return [
    {
      id: 'pack',
      header: 'Pack',
      priority: 1,
      grow: true,
      className: 'min-w-[12rem] py-2.5',
      cell: (p) => (
        <span className="flex min-w-0 flex-col gap-1.5">
          <PackTitleCell pack={p} />
          {/* The Source column folds in here while the table is narrow. */}
          <span className="@min-[56rem]:hidden">
            <PackSourceCell pack={p} />
          </span>
        </span>
      ),
    },
    {
      id: 'source',
      header: 'Source',
      priority: 1,
      className: 'hidden w-[14rem] min-w-[10rem] py-2.5 @min-[56rem]:table-cell',
      cell: (p) => <PackSourceCell pack={p} />,
    },
    {
      id: 'approved',
      header: 'Approved',
      priority: 1,
      className: 'w-[11rem] py-2.5',
      cell: (p) => <PackApprovedCell pack={p} />,
    },
    {
      id: 'used',
      header: 'Templates',
      priority: 3,
      nowrap: true,
      className: 'w-28 py-2.5 text-sm text-muted-foreground',
      cell: (p) => usedByText(p),
    },
    {
      id: 'follow',
      header: 'Follow updates',
      priority: 3,
      nowrap: true,
      className: 'w-[10.5rem] py-2.5',
      cell: (p) => <FollowToggle pack={p} />,
    },
    {
      id: 'enabled',
      header: 'Enabled',
      priority: 1,
      className: 'w-20 py-2.5',
      cell: (p) => <EnabledSwitch pack={p} />,
    },
    {
      id: 'actions',
      header: 'Actions',
      hideHeader: true,
      priority: 1,
      align: 'end',
      className: 'w-12 py-2.5',
      cell: (p) => <PackMenu pack={p} />,
    },
  ];
}

/** A pack under 768px: the whole card opens the pack; its controls sit above the link. */
export function PackCard({ pack }: { readonly pack: SitePackView }) {
  return (
    <article className="flex flex-col gap-3" aria-label={pack.title} data-band="card">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <PackTitleCell pack={pack} />
        </div>
        <div className="-mt-1 -mr-2 shrink-0">
          <PackMenu pack={pack} />
        </div>
      </div>
      <PackSourceCell pack={pack} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PackApprovedCell pack={pack} />
        <span className="text-sm text-muted-foreground">{usedByText(pack)}</span>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <FollowToggle pack={pack} />
        <span className="flex items-center gap-2 text-sm">
          <EnabledSwitch pack={pack} />
          Enabled
        </span>
      </div>
      <RevertButton pack={pack} />
    </article>
  );
}

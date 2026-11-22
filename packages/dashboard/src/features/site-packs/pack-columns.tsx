/** @module features/site-packs/pack-columns — the packs table of `/site-packs` (spec 13 §11.4) and its card under 768px: Pack (title, domains, Turned off, "Local file overrides vN", revoked by the publisher and still in force, a version waiting for review or listed online, "Pinned at v7, v9 available", "v9 needs BrowserHive ≥ …", why a version was skipped; the source folded in under a 56rem table) · Source (provenance, every source that knows the pack, local-file state) · Approved (version, short SHA-256 with copy, by and when, auto-updated) · Templates · Follow updates · Enabled · the row menu (Revert when a previous version exists) */

import type { SitePackView } from '@browserhive/contracts/http';
import { Chip } from '@/components/shared/Chip.tsx';
import { Plain } from '@/components/shared/Plain.tsx';
import { RelativeTime } from '@/components/shared/RelativeTime.tsx';
import type { DataTableColumn } from '@/components/shared/use-data-table.ts';
import { printable } from '@/lib/format/printable.ts';
import { useRegistryName } from './api.ts';
import { FOLLOW_LABEL, provenanceText, shortPath, shortProvenance, skippedText } from './model.ts';
import { LocalOverrideBadge, LocalStatePill, ShaText } from './PackBits.tsx';
import { EnabledSwitch, FollowToggle, PackMenu } from './PackControls.tsx';
import {
  autoUpdated,
  declinedOnline,
  needsClientText,
  newerOnline,
  newestAvailable,
  otherSources,
} from './registry-model.ts';

/** The update chip of a pack: waiting for review, pinned with a newer version, or listed online. */
function UpdateChip({ pack }: { readonly pack: SitePackView }) {
  const newest = newestAvailable(pack);
  if (pack.pinned_version !== null) {
    return (
      <Chip tone="neutral">
        Pinned at v{pack.pinned_version}
        {newest !== null ? `, v${newest} available` : ''}
      </Chip>
    );
  }
  if (pack.follow.effective && pack.pending.length > 0) {
    const last = pack.pending.reduce((a, b) => (b.version > a.version ? b : a));
    return (
      <Chip tone="accent">
        v{last.version} {last.state === 'available' ? 'available' : 'waiting for review'}
      </Chip>
    );
  }
  const declined = declinedOnline(pack);
  if (declined !== null) return <Chip tone="muted">v{declined} set aside</Chip>;
  const online = newerOnline(pack);
  return online !== null ? <Chip tone="neutral">v{online} online</Chip> : null;
}

/** Pack: title (the row link's text) over its domains and what needs care. */
export function PackTitleCell({ pack }: { readonly pack: SitePackView }) {
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="truncate text-base leading-5 font-medium text-foreground decoration-muted-foreground/60 underline-offset-4 group-hover/row:underline">
          <Plain>{pack.title}</Plain>
        </span>
        {!pack.enabled ? <Chip tone="muted">Turned off</Chip> : null}
        {pack.local_override ? (
          <LocalOverrideBadge version={pack.approved?.version ?? null} />
        ) : null}
        {pack.approved_revoked ? (
          <Chip tone="danger" className="h-auto min-h-5.5 py-0.5 whitespace-normal">
            Revoked by the publisher — still in force, review
          </Chip>
        ) : null}
        <UpdateChip pack={pack} />
      </span>
      <span className="font-mono text-sm leading-5 text-muted-foreground [overflow-wrap:anywhere]">
        <Plain>{pack.domains.join(', ')}</Plain>
      </span>
      {needsClientText(pack) !== null ? (
        <span className="text-sm text-muted-foreground">
          {printable(needsClientText(pack) ?? '')}
        </span>
      ) : null}
      {pack.skipped !== undefined ? (
        <span className="text-sm text-warn-text text-pretty">
          <Plain>{skippedText(pack.skipped)}</Plain>
        </span>
      ) : null}
    </span>
  );
}

/** Source: where the version in force (or on offer) came from, and the local file's state. */
export function PackSourceCell({ pack }: { readonly pack: SitePackView }) {
  const shown = pack.approved ?? pack.offer;
  const also = otherSources(pack, shown?.source ?? null);
  const registry = useRegistryName();
  const remote = shown?.provenance?.kind === 'remote' ? shown.provenance : null;
  return (
    <span className="flex min-w-0 flex-col items-start gap-1 text-sm">
      {shown !== null ? (
        remote !== null ? (
          <span
            className="flex min-w-0 flex-col"
            title={provenanceText(shown.provenance, shown.source, registry)}
          >
            <span>{registry}</span>
            <span className="text-muted-foreground">
              Key <span className="whitespace-nowrap">{printable(remote.key_id)}</span> · index{' '}
              {remote.index_version} · verified
            </span>
          </span>
        ) : (
          <span
            className="text-pretty [overflow-wrap:anywhere]"
            title={provenanceText(shown.provenance, shown.source, registry)}
          >
            {shortProvenance(shown.provenance, shown.source, registry)}
          </span>
        )
      ) : null}
      {also !== '' ? <span className="text-muted-foreground">{also}</span> : null}
      {pack.local !== null ? (
        <>
          {shown?.source !== 'local' ? (
            <span
              className="text-muted-foreground [overflow-wrap:anywhere]"
              title={printable(pack.local.path)}
            >
              Local file {printable(shortPath(pack.local.path))}
            </span>
          ) : null}
          <LocalStatePill local={pack.local} />
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
        <span className="font-medium text-foreground">Not approved yet</span>
        {pack.offer !== null ? <span>v{pack.offer.version} on first use</span> : null}
      </span>
    );
  }
  const { approved } = pack;
  return (
    <span className="flex min-w-0 flex-col items-start gap-0.5 text-sm">
      <span className="flex items-center gap-2 whitespace-nowrap">
        <span className="shrink-0 font-medium tabular-nums">v{approved.version}</span>
        <ShaText sha256={approved.sha256} className="text-muted-foreground" />
      </span>
      {approved.at !== null ? (
        <span className="text-muted-foreground">
          {autoUpdated(pack) ? 'Auto-updated' : (approved.by ?? 'Approved')} ·{' '}
          <RelativeTime at={approved.at} className="text-sm" />
        </span>
      ) : autoUpdated(pack) ? (
        <span className="text-muted-foreground">Auto-updated</span>
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
      className: 'hidden w-[15rem] min-w-[13rem] py-2.5 @min-[56rem]:table-cell',
      cell: (p) => <PackSourceCell pack={p} />,
    },
    {
      id: 'approved',
      header: 'Approved',
      priority: 1,
      className: 'w-[11rem] min-w-[10.5rem] py-2.5',
      cell: (p) => <PackApprovedCell pack={p} />,
    },
    {
      id: 'used',
      header: 'Templates',
      priority: 3,
      nowrap: true,
      className: 'w-28 min-w-[6.5rem] py-2.5 text-sm text-muted-foreground',
      cell: (p) => usedByText(p),
    },
    {
      id: 'follow',
      header: 'Follow updates',
      priority: 3,
      nowrap: true,
      className: 'w-[10.5rem] min-w-[10.5rem] py-2.5',
      cell: (p) => <FollowToggle pack={p} />,
    },
    {
      id: 'enabled',
      header: 'Enabled',
      priority: 1,
      className: 'w-20 min-w-[4.5rem] py-2.5',
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

/** A pack under 768px: the whole card opens the pack; its settings read as text and change from its menu. */
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
      {/* Settings change from the card's menu or the pack page: controls inside a card that is one big link would overlap it. */}
      <p className="text-sm text-muted-foreground">
        Follow updates: {FOLLOW_LABEL[pack.follow.setting]}
        {pack.follow.setting === 'auto' ? ` (${pack.follow.effective ? 'on' : 'off'})` : ''} ·{' '}
        {pack.enabled ? 'Enabled' : 'Turned off'}
      </p>
    </article>
  );
}

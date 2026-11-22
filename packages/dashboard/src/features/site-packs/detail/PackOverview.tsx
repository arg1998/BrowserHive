/** @module features/site-packs/detail/PackOverview — the side column of a pack's page (spec 13 §9.6, §11.4): the version in force with its provenance, SHA-256, who approved it and when (or what adding a site would approve), the sources that know the pack and what the registry lists (newest version, a version for another BrowserHive, revoked), the local file and its state, pinning, the pack's settings (Follow updates, Enabled, Revert…) and every version BrowserHive knows */
import type { SitePackDetailResponse, SitePackView } from '@browserhive/contracts/http';
import { useId } from 'react';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { Chip } from '@/components/shared/Chip.tsx';
import { RelativeTime } from '@/components/shared/RelativeTime.tsx';
import { Panel } from '@/components/shared/Section.tsx';
import { Button } from '@/components/ui/button.tsx';
import { ICONS } from '@/lib/icons.ts';
import { useSitePackActions } from '../api.ts';
import { iso, provenanceText, SOURCE_LABEL, skippedText } from '../model.ts';
import { LocalOverrideBadge, LocalStatePill, ShaText } from '../PackBits.tsx';
import { EnabledSwitch, FollowToggle, RevertButton } from '../PackControls.tsx';
import { autoUpdated, clientRangeText, sourcesText } from '../registry-model.ts';

const VERSION_STATE: {
  readonly [K in SitePackDetailResponse['versions'][number]['state']]: string;
} = {
  approved: 'In force',
  previous: 'Previous',
  pending: 'Waiting for review',
  rejected: 'Rejected',
  offered: 'Offered',
  local: 'Local file',
};

/** The version in force, or on offer. */
function InForce({ view }: { readonly view: SitePackView }) {
  const actions = useSitePackActions(view.pack_id);
  const toast = useToast();
  const approved = view.approved;
  if (approved === null) {
    return (
      <div className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">Not approved yet</span>
        {view.offer !== null ? (
          <>
            <span className="text-muted-foreground">
              Adding one of its sites to a template approves v{view.offer.version}:
            </span>
            <bdi>{provenanceText(view.offer.provenance, view.offer.source)}</bdi>
            <ShaText sha256={view.offer.sha256} />
          </>
        ) : (
          <span className="text-muted-foreground">
            {view.local !== null
              ? 'Nothing is on offer until its local file is approved.'
              : view.skipped !== undefined
                ? 'Not in force: no version of it can apply.'
                : 'Nothing is on offer.'}
          </span>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5 text-sm">
      <span className="flex flex-wrap items-center gap-2">
        <span className="text-base font-semibold tabular-nums">v{approved.version}</span>
        <Chip>{SOURCE_LABEL[approved.source]}</Chip>
        {view.local_override ? <LocalOverrideBadge version={approved.version} /> : null}
      </span>
      <bdi className="[overflow-wrap:anywhere]">
        {provenanceText(approved.provenance, approved.source)}
      </bdi>
      <ShaText sha256={approved.sha256} />
      {approved.at !== null ? (
        <span className="text-muted-foreground">
          {autoUpdated(view)
            ? 'Applied by auto-update'
            : `Approved${approved.by !== null ? ` by ${approved.by}` : ''}`}{' '}
          <RelativeTime at={approved.at} className="text-sm" />
        </span>
      ) : null}
      {view.pinned_version !== null ? (
        <span className="mt-1 flex flex-wrap items-center gap-2">
          <Chip tone="neutral">Pinned at v{view.pinned_version}</Chip>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={actions.pin.isPending}
            onClick={() =>
              actions.pin.mutate(null, {
                onSuccess: () => toast.success({ title: `${iso(view.title)} unpinned` }),
              })
            }
          >
            <ICONS.unpin aria-hidden="true" />
            Unpin
          </Button>
        </span>
      ) : null}
    </div>
  );
}

/** Where the pack is known from, and what the signed index lists for it. */
function Sources({ view }: { readonly view: SitePackView }) {
  const online = view.online;
  return (
    <div className="flex flex-col gap-1.5 border-t pt-4 text-sm">
      <span className="font-medium">Sources</span>
      <span>{sourcesText(view) || 'None'}</span>
      {online !== null ? (
        <span className="flex flex-col gap-0.5 text-muted-foreground">
          <span>
            Registry lists v{online.version} · released {online.released}
            {online.revoked ? ' · revoked' : ''}
          </span>
          {online.needs_client !== null ? (
            <span>
              v{online.version} needs BrowserHive {clientRangeText(online.needs_client)}
              {online.usable_version !== null
                ? `; v${online.usable_version} is the newest this BrowserHive can use`
                : ''}
            </span>
          ) : null}
        </span>
      ) : view.sources.includes('remote') ? null : (
        <span className="text-muted-foreground">Not in the registry index</span>
      )}
    </div>
  );
}

/** The side column. */
export function PackOverview({ detail }: { readonly detail: SitePackDetailResponse }) {
  const { view } = detail;
  const enabledId = useId();
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Panel title="In force">
        <div className="flex flex-col gap-4">
          <InForce view={view} />
          {view.approved_revoked ? (
            <p className="rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger-text text-pretty">
              Revoked by the publisher — still in force, review.
            </p>
          ) : null}
          <Sources view={view} />
          {view.local !== null ? (
            <div className="flex flex-col gap-1.5 border-t pt-4 text-sm">
              <span className="font-medium">Local file</span>
              <bdi className="font-mono text-xs [overflow-wrap:anywhere]">{view.local.path}</bdi>
              <LocalStatePill local={view.local} />
              {view.local.problem !== null ? (
                <span className="text-warn-text text-pretty">{view.local.problem}</span>
              ) : null}
            </div>
          ) : null}
          {view.skipped !== undefined ? (
            <p className="border-t pt-4 text-sm text-warn-text text-pretty">
              <bdi>{skippedText(view.skipped)}</bdi>
            </p>
          ) : null}
        </div>
      </Panel>
      <Panel title="Settings">
        <div className="flex flex-col gap-4 text-sm">
          <div className="flex flex-col gap-1.5">
            <span className="font-medium">Follow updates</span>
            <FollowToggle pack={view} label="Follow updates" />
            <span className="text-muted-foreground">
              {view.follow.setting === 'auto'
                ? `Auto: followed while a template uses it (now ${view.follow.effective ? 'on' : 'off'}).`
                : view.follow.effective
                  ? 'New versions are listed under Updates available.'
                  : 'New versions are not listed.'}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <EnabledSwitch pack={view} id={enabledId} />
            <label htmlFor={enabledId} className="text-base">
              {view.enabled ? 'Enabled' : 'Turned off: its sites act as generic sites'}
            </label>
          </div>
          <RevertButton pack={view} />
        </div>
      </Panel>
      <Panel title="Versions">
        <ul className="flex flex-col divide-y text-sm">
          {detail.versions.map((v) => (
            <li
              key={`${v.source}:${v.sha256}`}
              className="flex min-w-0 flex-col gap-0.5 py-2 first:pt-0 last:pb-0"
            >
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-medium tabular-nums">
                  {v.version === null ? 'Local file' : `v${v.version}`}
                </span>
                <Chip tone={v.state === 'approved' ? 'success' : 'neutral'}>
                  {VERSION_STATE[v.state]}
                </Chip>
                <span className="text-muted-foreground">{SOURCE_LABEL[v.source]}</span>
              </span>
              <ShaText sha256={v.sha256} className="text-muted-foreground" />
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}

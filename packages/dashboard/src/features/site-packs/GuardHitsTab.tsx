/** @module features/site-packs/GuardHitsTab — the Guard hits tab of `/site-packs` (spec 13 §9.9, §11.4; `GET /site-packs/guard-hits`): every request or control a pack blocked, asked about, flagged, paced or held, newest first, with the guard, the method and the sanitized URL as text, the session and the tool; filterable by what happened */

import { SiteGuardHitAction, type SiteGuardHitRow } from '@browserhive/contracts/http';
import { useState } from 'react';
import { Chip } from '@/components/shared/Chip.tsx';
import { EmptyState } from '@/components/shared/EmptyState.tsx';
import { FilterBar } from '@/components/shared/FilterBar.tsx';
import { Plain } from '@/components/shared/Plain.tsx';
import { RelativeTime } from '@/components/shared/RelativeTime.tsx';
import { useSiteGuardHits } from './api.ts';
import { PagedList } from './HistoryTabs.tsx';

type HitAction = SiteGuardHitRow['action'];

const ACTION_LABEL: { readonly [K in HitAction]: string } = {
  block: 'Blocked',
  confirm: 'Asked first',
  warn: 'Flagged',
  paced: 'Paced',
  held: 'Held',
};

const KIND_LABEL = {
  logout: 'Sign-out',
  account: 'Account page',
  credential: 'Credential',
  destructive: 'Destructive',
  write: 'Write',
  stop: 'Site stopped',
} as const;

/** Guard hits tab. */
export function GuardHitsTab() {
  const [action, setAction] = useState<readonly string[] | undefined>(undefined);
  const query = useSiteGuardHits(action);
  const rows = query.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <FilterBar
        chips={[
          {
            param: 'action',
            label: 'What happened',
            options: SiteGuardHitAction.options.map((value) => ({ value, count: 0 })),
            selected: action ?? [],
            format: (v) => ACTION_LABEL[v as HitAction] ?? v,
            counts: false,
          },
        ]}
        onChange={(_param, value) =>
          setAction(Array.isArray(value) && value.length > 0 ? value : undefined)
        }
        onClear={() => setAction(undefined)}
      />
      <PagedList
        query={query}
        label="Guard hits"
        more="Show older hits"
        empty={
          <EmptyState
            kind={action === undefined ? 'zero-data' : 'zero-results'}
            variant="panel"
            icon="blocklist"
            title={action === undefined ? 'Nothing guarded yet' : 'No hits match'}
            description="Sign-outs, account pages and writes a pack blocked, asked you about or flagged are listed here."
            {...(action !== undefined && { onClear: () => setAction(undefined) })}
          />
        }
      >
        {rows.map((hit) => (
          <li
            key={hit.event_id}
            className="flex min-w-0 flex-col gap-1 px-5 py-3 sm:flex-row sm:items-start sm:gap-6"
          >
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="font-medium">{ACTION_LABEL[hit.action]}</span>
                <Chip>{KIND_LABEL[hit.guard_kind]}</Chip>
                <Plain className="font-mono text-sm text-muted-foreground">
                  {`${hit.pack_id}#${hit.guard_id}`}
                </Plain>
                {hit.outcome !== null ? (
                  <span className="text-sm text-muted-foreground">· {hit.outcome}</span>
                ) : null}
              </p>
              <p className="min-w-0 font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">
                {hit.method !== null ? `${hit.method} ` : ''}
                <Plain>{hit.url}</Plain>
              </p>
              {hit.session_id !== null || hit.tool !== null ? (
                <p className="text-sm text-muted-foreground">
                  {hit.session_id !== null ? `Session ${hit.session_id}` : 'BrowserHive (system)'}
                  {hit.tool !== null ? ` · ${hit.tool}` : ''}
                </p>
              ) : null}
            </div>
            <RelativeTime at={hit.ts} className="shrink-0 text-sm text-muted-foreground" />
          </li>
        ))}
      </PagedList>
    </div>
  );
}

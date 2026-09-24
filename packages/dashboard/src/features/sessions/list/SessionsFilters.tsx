/** @module features/sessions/list/SessionsFilters — FilterBar for `/sessions`: View toggle group, Owner select, Channel/Persistence/Harness chips with facet counts, search, active tokens (spec 04 §12.2) */
import type { SessionFacets } from '@browserhive/contracts/http';
import {
  type FacetChip,
  FilterBar,
  type FilterSelect,
  type FilterToken,
} from '@/components/shared/FilterBar.tsx';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group.tsx';
import { formatAbsoluteShort } from '@/lib/format/time.ts';
import { harnessLabel } from '@/lib/harness.ts';
import type { SessionsSearch } from '../search.ts';

/** View options (segmented control). */
const VIEWS = [
  { value: 'all', label: 'All' },
  { value: 'live', label: 'Live' },
  { value: 'closed', label: 'Closed' },
  { value: 'archived', label: 'Archived' },
] as const;

/** Props. */
export interface SessionsFiltersProps {
  readonly search: SessionsSearch;
  readonly facets: SessionFacets | undefined;
  readonly matching: number | undefined;
  readonly onChange: (param: string, value: string | readonly string[] | undefined) => void;
  readonly onClear: () => void;
}

/** Filters. */
export function SessionsFilters({
  search,
  facets,
  matching,
  onChange,
  onClear,
}: SessionsFiltersProps) {
  const chips: FacetChip[] = [
    {
      param: 'channel',
      label: 'Channel',
      options: facets?.channels ?? [],
      selected: search.channel ?? [],
    },
    {
      param: 'persistence',
      label: 'Persistence',
      options: facets?.persistence_modes ?? [],
      selected: search.persistence ?? [],
    },
    {
      param: 'harness',
      label: 'Harness',
      options: facets?.harnesses ?? [],
      selected: search.harness ?? [],
      format: harnessLabel,
    },
  ].filter((chip) => chip.options.length > 1 || chip.selected.length > 0);
  const tokens: FilterToken[] = [];
  if (search.owner !== undefined) {
    tokens.push({
      key: 'owner',
      value: search.owner,
      onRemove: () => onChange('owner', undefined),
    });
  }
  if (search.since !== undefined) {
    tokens.push({
      key: 'since',
      value: formatAbsoluteShort(search.since),
      onRemove: () => onChange('since', undefined),
    });
  }
  if (search.until !== undefined) {
    tokens.push({
      key: 'until',
      value: formatAbsoluteShort(search.until),
      onRemove: () => onChange('until', undefined),
    });
  }
  if (search.archived !== undefined) {
    tokens.push({
      key: 'archived',
      value: 'include',
      onRemove: () => onChange('archived', undefined),
    });
  }
  const owners = facets?.owners ?? [];
  const selects: FilterSelect[] =
    owners.length > 1 || search.owner !== undefined
      ? [
          {
            param: 'owner',
            label: 'Owner',
            allLabel: 'All owners',
            value: search.owner,
            options: owners.map((owner) => ({ value: String(owner.value), count: owner.count })),
          },
        ]
      : [];
  return (
    <FilterBar
      search={{ param: 'q', placeholder: 'Search slug or id…', value: search.q }}
      selects={selects}
      chips={chips}
      tokens={tokens}
      {...(matching !== undefined && { matching })}
      range={
        <ToggleGroup
          aria-label="View"
          size="sm"
          spacing={0}
          value={[search.view ?? 'all']}
          onValueChange={(value: readonly string[]) => {
            const next = value[0];
            onChange('view', next === undefined || next === 'all' ? undefined : next);
          }}
        >
          {VIEWS.map((view) => (
            <ToggleGroupItem
              key={view.value}
              value={view.value}
              aria-label={`${view.label} sessions`}
            >
              {view.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      }
      onChange={onChange}
      onClear={onClear}
    />
  );
}

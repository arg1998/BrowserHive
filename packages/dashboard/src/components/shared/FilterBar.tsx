/** @module components/shared/FilterBar — search (300 ms debounce that survives re-renders), selects, facet chips with a real selected state, active tokens, matching count, Clear all; state lives in the URL */
import type { Facet } from '@browserhive/contracts/http';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useShortcut } from '@/app/providers/KeyboardProvider.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Kbd } from '@/components/ui/kbd.tsx';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select.tsx';
import { formatNumber } from '@/lib/format/bytes.ts';
import { ICONS } from '@/lib/icons.ts';
import { cn } from '@/lib/utils.ts';
import { Toolbar } from './Toolbar.tsx';

/** A multi-select facet rendered as toggle chips with counts. */
export interface FacetChip {
  readonly param: string;
  readonly label: string;
  readonly options: readonly Facet[];
  readonly selected: readonly string[];
  readonly format?: (value: string) => string;
  /** `false` hides the counts (when no meaningful facet counts exist). Default `true`. */
  readonly counts?: boolean;
}

/** A single-value select (Owner, Status). `undefined` value = the "all" option. */
export interface FilterSelect {
  readonly param: string;
  readonly label: string;
  readonly value: string | undefined;
  readonly options: readonly {
    readonly value: string;
    readonly label?: string;
    readonly count?: number;
  }[];
  /** Label of the "no filter" option (default `All`). */
  readonly allLabel?: string;
  readonly className?: string;
}

/** An active `key:value` pill. */
export interface FilterToken {
  readonly key: string;
  readonly value: string;
  readonly onRemove: () => void;
}

/** Props. */
export interface FilterBarProps {
  readonly search?: {
    readonly param: string;
    readonly placeholder: string;
    readonly value: string | undefined;
  };
  readonly selects?: readonly FilterSelect[];
  readonly chips?: readonly FacetChip[];
  readonly tokens?: readonly FilterToken[];
  /** Extra controls on the first row (time range, view toggle). */
  readonly range?: ReactNode;
  readonly savedViews?: ReactNode;
  /** Controls pinned to the right end of the first row (View menu, export). */
  readonly end?: ReactNode;
  readonly matching?: number;
  readonly onChange: (param: string, value: string | readonly string[] | undefined) => void;
  readonly onClear: () => void;
  readonly className?: string;
}

const ALL = '__all__';

/**
 * Debounced search draft. The timer only restarts when the draft or the committed value changes,
 * never because the parent re-rendered (live tails re-render many times a second).
 */
export function useDebouncedSearch(
  committed: string,
  commit: (value: string | undefined) => void,
  delayMs = 300,
): readonly [string, (next: string) => void] {
  const [draft, setDraft] = useState(committed);
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useEffect(() => setDraft(committed), [committed]);
  useEffect(() => {
    if (draft === committed) return undefined;
    const timer = setTimeout(() => {
      const trimmed = draft.trim();
      commitRef.current(trimmed === '' ? undefined : trimmed);
    }, delayMs);
    return () => clearTimeout(timer);
  }, [draft, committed, delayMs]);
  return [draft, setDraft];
}

/** Filter bar. */
export function FilterBar({
  search,
  selects = [],
  chips = [],
  tokens = [],
  range,
  savedViews,
  end,
  matching,
  onChange,
  onClear,
  className,
}: FilterBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const searchId = useId();
  const committed = search?.value ?? '';
  const param = search?.param;
  const [draft, setDraft] = useDebouncedSearch(committed, (value) => {
    if (param !== undefined) onChange(param, value);
  });
  useShortcut(
    {
      id: 'filter.focus',
      combo: '/',
      description: 'Focus the page filter',
      scope: 'page',
      group: 'Page',
      handler: () => {
        inputRef.current?.focus();
        return undefined;
      },
    },
    search !== undefined,
  );
  const active =
    tokens.length > 0 ||
    chips.some((c) => c.selected.length > 0) ||
    selects.some((s) => s.value !== undefined) ||
    committed !== '';
  const SearchIcon = ICONS.search;
  const Close = ICONS.close;
  const Check = ICONS.check;
  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <Toolbar aria-label="Filters" className="gap-2">
        {search !== undefined ? (
          <div className="relative flex w-full min-w-48 items-center sm:w-auto sm:max-w-sm sm:flex-1">
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute left-3 size-4 text-muted-foreground"
            />
            <label htmlFor={searchId} className="sr-only">
              {search.placeholder}
            </label>
            <Input
              id={searchId}
              ref={inputRef}
              type="search"
              placeholder={search.placeholder}
              className="pr-9 pl-9"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && draft !== '') {
                  event.stopPropagation();
                  setDraft('');
                }
              }}
            />
            {draft === '' ? (
              <Kbd className="pointer-events-none absolute right-2.5 hidden sm:inline-flex">/</Kbd>
            ) : (
              <button
                type="button"
                aria-label="Clear search"
                className="absolute right-1.5 flex size-6 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground pointer-coarse:right-0 pointer-coarse:size-10"
                onClick={() => {
                  setDraft('');
                  inputRef.current?.focus();
                }}
              >
                <Close aria-hidden="true" className="size-3.5" />
              </button>
            )}
          </div>
        ) : null}
        {selects.map((select) => (
          <FilterSelectControl key={select.param} select={select} onChange={onChange} />
        ))}
        {range}
        {savedViews}
        <div className="ml-auto flex items-center gap-2">
          {matching !== undefined ? (
            <span className="text-sm whitespace-nowrap text-muted-foreground tabular-nums">
              {formatNumber(matching)} matching
            </span>
          ) : null}
          {active ? (
            <Button type="button" variant="ghost" size="sm" onClick={onClear}>
              Clear all
            </Button>
          ) : null}
          {end}
        </div>
      </Toolbar>
      {chips.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          {chips.map((chip) => (
            <fieldset key={chip.param} className="flex flex-wrap items-center gap-1.5">
              <legend className="sr-only">{chip.label}</legend>
              <span aria-hidden="true" className="mr-0.5 text-sm text-muted-foreground">
                {chip.label}
              </span>
              {chip.options.map((option) => {
                const value = String(option.value);
                const on = chip.selected.includes(value);
                return (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={on}
                    className={cn(
                      'inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-sm transition-colors duration-(--duration-fast) pointer-coarse:h-10 pointer-coarse:px-3.5',
                      on
                        ? 'border-accent-border bg-accent-bg font-medium text-accent-text hover:bg-accent-bg-hover'
                        : 'border-input bg-card text-foreground hover:border-border-strong hover:bg-accent dark:bg-transparent',
                    )}
                    onClick={() =>
                      onChange(
                        chip.param,
                        on ? chip.selected.filter((v) => v !== value) : [...chip.selected, value],
                      )
                    }
                  >
                    {on ? <Check aria-hidden="true" className="-ml-0.5 size-3.5" /> : null}
                    {chip.format !== undefined ? chip.format(value) : value}
                    {chip.counts === false ? null : (
                      <span
                        className={cn(
                          'text-xs tabular-nums',
                          on ? 'text-accent-text/80' : 'text-muted-foreground',
                        )}
                      >
                        {formatNumber(option.count)}
                      </span>
                    )}
                  </button>
                );
              })}
            </fieldset>
          ))}
        </div>
      ) : null}
      {tokens.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="Active filters">
          {tokens.map((token) => (
            <li key={`${token.key}:${token.value}`}>
              <span className="inline-flex h-7 items-center gap-1 rounded-full bg-accent-bg pr-1 pl-2.5 text-sm text-accent-text pointer-coarse:h-10 pointer-coarse:pl-3.5">
                <span className="opacity-80">{token.key}:</span>
                <span className="max-w-56 truncate font-mono text-sm">{token.value}</span>
                <button
                  type="button"
                  aria-label={`Remove filter ${token.key} ${token.value}`}
                  className="ml-0.5 flex size-5 cursor-pointer items-center justify-center rounded-full hover:bg-accent-bg-hover pointer-coarse:size-8"
                  onClick={token.onRemove}
                >
                  <Close aria-hidden="true" className="size-3.5" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function FilterSelectControl({
  select,
  onChange,
}: {
  readonly select: FilterSelect;
  readonly onChange: FilterBarProps['onChange'];
}) {
  const labelId = useId();
  const allLabel = select.allLabel ?? 'All';
  const items = [
    { value: ALL, label: allLabel },
    ...select.options.map((o) => ({
      value: o.value,
      label: `${o.label ?? o.value}${o.count !== undefined ? ` (${formatNumber(o.count)})` : ''}`,
    })),
  ];
  return (
    <div className="flex items-center gap-2">
      <span id={labelId} className="sr-only">
        {select.label}
      </span>
      <Select
        items={items}
        value={select.value ?? ALL}
        onValueChange={(value) =>
          onChange(select.param, value === ALL || value === null ? undefined : String(value))
        }
      >
        <SelectTrigger
          aria-labelledby={labelId}
          className={cn(
            'min-w-36 max-w-56',
            select.value !== undefined && 'border-accent-border',
            select.className,
          )}
        >
          <span className="text-muted-foreground">{select.label}:</span>
          <SelectValue className="truncate" />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false} align="start">
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

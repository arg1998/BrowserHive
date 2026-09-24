/** @module features/system/config/ConfigTable — effective configuration with provenance: 14px keys, 13px mono values that wrap, where each value came from (cli › file › env › default), the environment variables behind config-file references (`$NAME` chips, spec 08 §3.1) and the lower-precedence values it overrode; secrets shown as `redacted`; filter by key, value, source or variable, optionally only values that differ from the defaults or only values from references (D-06, D-29) */
import type { ProvenanceSource } from '@browserhive/contracts/enums';
import { REDACTED, type SystemConfigKey } from '@browserhive/contracts/http';
import { useId, useState } from 'react';
import { Chip } from '@/components/shared/Chip.tsx';
import { EmptyState } from '@/components/shared/EmptyState.tsx';
import { useDebouncedSearch } from '@/components/shared/FilterBar.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Switch } from '@/components/ui/switch.tsx';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table.tsx';
import { formatNumber } from '@/lib/format/bytes.ts';
import { ICONS } from '@/lib/icons.ts';
import type { Tone } from '@/lib/status-registry.ts';
import { cn } from '@/lib/utils.ts';
import { RefChip, rowRefs } from './RefChip.tsx';

/** How each provenance source reads, most precedent first. */
export const SOURCE_INFO: {
  readonly [S in ProvenanceSource]: { readonly tone: Tone; readonly hint: string };
} = {
  cli: { tone: 'accent', hint: 'Set by a command-line flag' },
  file: { tone: 'info', hint: 'Set in browserhive.config.json' },
  env: { tone: 'vault', hint: 'Set by an environment variable' },
  'env(otel)': { tone: 'vault', hint: 'Set by a standard OTEL_* environment variable' },
  derived: { tone: 'neutral', hint: 'Derived from other settings' },
  default: { tone: 'muted', hint: 'Built-in default' },
};

/** Display text for a config value (secrets never show their value). */
export function configDisplay(value: unknown, secret: boolean): string {
  if (secret || value === REDACTED) return 'redacted';
  if (value === undefined || value === null) return '—';
  if (typeof value === 'string') return value === '' ? '""' : value;
  return JSON.stringify(value);
}

/** Whether a row's value, or a value it overrode, came through config-file references. */
export function usesRefs(key: SystemConfigKey): boolean {
  return (key.refs?.length ?? 0) > 0 || key.shadowed.some((s) => (s.refs?.length ?? 0) > 0);
}

function refNames(key: SystemConfigKey): readonly string[] {
  return [...(key.refs ?? []), ...key.shadowed.flatMap((s) => s.refs ?? [])].map((r) =>
    r.ref.toLowerCase(),
  );
}

/**
 * Rows matching the filter: key, displayed value, source or variable name (with or without `$`),
 * case-insensitive; optionally only values changed from the defaults, only values from references.
 */
export function filterConfig(
  keys: readonly SystemConfigKey[],
  needle: string,
  changedOnly: boolean,
  refsOnly = false,
): readonly SystemConfigKey[] {
  const q = needle.trim().toLowerCase();
  const variable = q.startsWith('$') ? q.slice(1) : q;
  return keys.filter((k) => {
    if (changedOnly && k.source === 'default') return false;
    if (refsOnly && !usesRefs(k)) return false;
    if (q === '') return true;
    return (
      k.key.toLowerCase().includes(q) ||
      k.source.includes(q) ||
      (variable !== '' && refNames(k).some((name) => name.includes(variable))) ||
      (!k.secret && configDisplay(k.value, false).toLowerCase().includes(q))
    );
  });
}

function Source({ row }: { readonly row: SystemConfigKey }) {
  const info = SOURCE_INFO[row.source];
  const refs = rowRefs(row.refs);
  return (
    // The variable chips sit beside the source chip and wrap below it only when the column is narrow.
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      <Chip tone={info.tone} className="font-mono">
        {row.source}
        <span className="sr-only">: {info.hint}</span>
      </Chip>
      {refs.length > 0 ? (
        <ul
          aria-label={`Environment variables ${row.key} reads`}
          className="flex max-w-full flex-wrap items-center gap-1"
        >
          {refs.map((ref) => (
            <li key={ref.name} className="max-w-full">
              <RefChip
                configKey={row.key}
                refInfo={ref}
                template={row.template}
                secret={row.secret}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Props. */
export interface ConfigTableProps {
  readonly keys: readonly SystemConfigKey[];
  /** Committed filter (URL `key`). */
  readonly filter: string | undefined;
  readonly onFilterChange: (value: string | undefined) => void;
}

/** Config table. */
export function ConfigTable({ keys, filter, onFilterChange }: ConfigTableProps) {
  const inputId = useId();
  const switchId = useId();
  const [draft, setDraft] = useDebouncedSearch(filter ?? '', onFilterChange, 150);
  const refsSwitchId = useId();
  const [changedOnly, setChangedOnly] = useState(false);
  const [refsOnly, setRefsOnly] = useState(false);
  const rows = filterConfig(keys, draft, changedOnly, refsOnly);
  const changed = keys.filter((k) => k.source !== 'default').length;
  const fromRefs = keys.filter(usesRefs).length;
  const Search = ICONS.search;
  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 border-t px-5 py-3">
        <div className="relative flex min-w-0 flex-[1_1_16rem] items-center sm:max-w-sm">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-3 size-4 text-muted-foreground"
          />
          <label htmlFor={inputId} className="sr-only">
            Filter configuration keys
          </label>
          <Input
            id={inputId}
            type="search"
            placeholder={
              fromRefs > 0
                ? 'Filter by key, value, source or $VARIABLE…'
                : 'Filter by key, value or source…'
            }
            className="pl-9"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </div>
        <label htmlFor={switchId} className="flex items-center gap-2 text-sm">
          <Switch id={switchId} size="sm" checked={changedOnly} onCheckedChange={setChangedOnly} />
          Only changed from defaults
          <span className="text-muted-foreground tabular-nums">({formatNumber(changed)})</span>
        </label>
        {fromRefs > 0 ? (
          <label htmlFor={refsSwitchId} className="flex items-center gap-2 text-sm">
            <Switch id={refsSwitchId} size="sm" checked={refsOnly} onCheckedChange={setRefsOnly} />
            Only values from references
            <span className="text-muted-foreground tabular-nums">({formatNumber(fromRefs)})</span>
          </label>
        ) : null}
        <span className="ml-auto text-sm text-muted-foreground tabular-nums">
          {formatNumber(rows.length)} of {formatNumber(keys.length)}
        </span>
      </div>
      {rows.length === 0 ? (
        <EmptyState
          kind="zero-results"
          title="No keys match"
          onClear={() => {
            setDraft('');
            setChangedOnly(false);
            setRefsOnly(false);
          }}
          size="sm"
          className="border-t"
        />
      ) : (
        <section aria-label="Effective configuration">
          <Table className="table-fixed">
            <colgroup>
              <col className="w-[34%] sm:w-[30%]" />
              <col />
              {/* Wider when a `$VARIABLE` chip sits under the source chip. */}
              <col className={keys.some(usesRefs) ? 'w-28 sm:w-44' : 'w-24 sm:w-28'} />
            </colgroup>
            <TableHeader>
              <TableRow>
                <TableHead className="border-t" scope="col">
                  Key
                </TableHead>
                <TableHead className="border-t" scope="col">
                  Value
                </TableHead>
                <TableHead className="border-t" scope="col">
                  Source
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.key} className="align-top">
                  <TableHead
                    scope="row"
                    className="h-auto py-2.5 align-top text-base font-medium whitespace-normal text-foreground [overflow-wrap:anywhere]"
                  >
                    {row.key}
                  </TableHead>
                  <TableCell className="py-2.5 align-top">
                    <div className="flex min-w-0 flex-col gap-1">
                      {row.secret || row.value === REDACTED ? (
                        <span>
                          <Chip tone="muted">redacted</Chip>
                        </span>
                      ) : (
                        <code
                          className={cn(
                            'font-mono text-sm [overflow-wrap:anywhere] whitespace-pre-wrap',
                            row.source === 'default' && 'text-muted-foreground',
                          )}
                        >
                          {configDisplay(row.value, false)}
                        </code>
                      )}
                      {row.shadowed.length > 0 ? (
                        <ul
                          aria-label={`Values ${row.key} overrides`}
                          className="flex flex-col gap-0.5 text-sm text-muted-foreground"
                        >
                          {row.shadowed.map((s, index) => (
                            <li
                              // biome-ignore lint/suspicious/noArrayIndexKey: positional (highest precedence first); a source may repeat
                              key={`${s.source}:${index}`}
                              className="flex min-w-0 flex-wrap items-baseline gap-x-1.5"
                            >
                              <span>overrides</span>
                              <span className="font-mono">{s.source}</span>
                              <code className="min-w-0 font-mono [overflow-wrap:anywhere] line-through decoration-muted-foreground/60">
                                {configDisplay(s.value, row.secret)}
                              </code>
                              {rowRefs(s.refs).length > 0 ? (
                                <span>
                                  via{' '}
                                  <span className={cn('font-mono', 'text-vault-text')}>
                                    {rowRefs(s.refs)
                                      .map((ref) => `$${ref.name}`)
                                      .join(', ')}
                                  </span>
                                </span>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="py-2.5 align-top">
                    <Source row={row} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      )}
    </div>
  );
}

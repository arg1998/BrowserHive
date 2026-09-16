/** @module features/system/config/ConfigTable — effective configuration with provenance: 14px keys, 13px mono values that wrap, where each value came from (cli › file › env › default) and the lower-precedence values it overrode; secrets shown as `redacted`; filter by key, value or source, optionally only values that differ from the defaults (D-06) */
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

/** Rows matching the filter (key, displayed value or source, case-insensitive). */
export function filterConfig(
  keys: readonly SystemConfigKey[],
  needle: string,
  changedOnly: boolean,
): readonly SystemConfigKey[] {
  const q = needle.trim().toLowerCase();
  return keys.filter((k) => {
    if (changedOnly && k.source === 'default') return false;
    if (q === '') return true;
    return (
      k.key.toLowerCase().includes(q) ||
      k.source.includes(q) ||
      (!k.secret && configDisplay(k.value, false).toLowerCase().includes(q))
    );
  });
}

function Source({ source }: { readonly source: ProvenanceSource }) {
  const info = SOURCE_INFO[source];
  return (
    <Chip tone={info.tone} className="font-mono">
      {source}
      <span className="sr-only">: {info.hint}</span>
    </Chip>
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
  const [changedOnly, setChangedOnly] = useState(false);
  const rows = filterConfig(keys, draft, changedOnly);
  const changed = keys.filter((k) => k.source !== 'default').length;
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
            placeholder="Filter by key, value or source…"
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
              <col className="w-24 sm:w-28" />
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
                          {row.shadowed.map((s) => (
                            <li
                              key={s.source}
                              className="flex min-w-0 flex-wrap items-baseline gap-x-1.5"
                            >
                              <span>overrides</span>
                              <span className="font-mono">{s.source}</span>
                              <code className="min-w-0 font-mono [overflow-wrap:anywhere] line-through decoration-muted-foreground/60">
                                {configDisplay(s.value, row.secret)}
                              </code>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="py-2.5 align-top">
                    <Source source={row.source} />
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

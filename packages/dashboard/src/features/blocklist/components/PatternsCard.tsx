/** @module features/blocklist/components/PatternsCard — loaded patterns ranked by hits as a compact `BarList` (warn fill); never-fired rows show `—` with the explaining tooltip, click toggles the `pattern` filter; capped at 10 rows with "Show all" so a long file never pushes the page */
import type { BlocklistOverview } from '@browserhive/contracts/http';
import { useState } from 'react';
import { Panel } from '@/components/shared/Section.tsx';
import { Button } from '@/components/ui/button.tsx';
import { BarList } from '@/features/websites/components/BarList.tsx';
import { formatNumber } from '@/lib/format/bytes.ts';
import { formatRelative } from '@/lib/format/time.ts';
import { useServerNow } from '@/lib/server-now.ts';

/** Rows shown before "Show all". */
export const PATTERNS_CAP = 10;

/** Props. */
export interface PatternsCardProps {
  readonly state: BlocklistOverview;
  readonly rangeLabel: string;
  readonly active: string | undefined;
  readonly onPick: (pattern: string) => void;
}

/** Tooltip for a pattern row. */
export function patternTitle(
  hits: number,
  line: number,
  lastTs: number | null,
  now: number,
): string {
  if (hits === 0) {
    return `Line ${line} — never matched in this window. If you expected it to, check the pattern shape.`;
  }
  return `${formatNumber(hits)} refused · last ${formatRelative(lastTs ?? 0, now)} — click to filter`;
}

/** Patterns ranked by hits (stable for ties: file order). */
export function rankPatterns<P extends { readonly hits: number; readonly line: number }>(
  patterns: readonly P[],
): P[] {
  return [...patterns].sort((a, b) => b.hits - a.hits || a.line - b.line);
}

/** Patterns card. */
export function PatternsCard({ state, rangeLabel, active, onPick }: PatternsCardProps) {
  const now = useServerNow(30_000);
  const [expanded, setExpanded] = useState(false);
  const ranked = rankPatterns(state.patterns);
  const neverFired = ranked.filter((p) => p.hits === 0).length;
  // The active filter always stays visible, even past the cap.
  const shown = expanded
    ? ranked
    : ranked.filter((p, i) => i < PATTERNS_CAP || p.pattern === active);
  const hidden = ranked.length - shown.length;
  return (
    <Panel
      title="Patterns"
      description={`Hits · ${rangeLabel}${neverFired > 0 ? ` · ${formatNumber(neverFired)} never fired` : ''}`}
      padding="none"
      bodyClassName="px-2.5 pt-1 pb-3"
    >
      {ranked.length === 0 ? (
        <p className="px-2.5 py-2 text-sm text-muted-foreground">
          The blocklist file contains no usable patterns.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <BarList
            label="Patterns by hits"
            tone="warn"
            items={shown.map((p) => ({
              key: p.pattern,
              label: <span className="font-mono text-sm">{p.pattern}</span>,
              value: p.hits,
              ...(p.hits === 0 && { valueLabel: '—' }),
              active: active === p.pattern,
              onClick: () => onPick(p.pattern),
              hint: patternTitle(p.hits, p.line, p.last_ts, now),
            }))}
          />
          {hidden > 0 || expanded ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="self-start text-muted-foreground"
              aria-expanded={expanded}
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? 'Show top 10' : `Show all ${formatNumber(ranked.length)} patterns`}
            </Button>
          ) : null}
        </div>
      )}
    </Panel>
  );
}

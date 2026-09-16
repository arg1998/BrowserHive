/** @module features/vault/tester/TesterPanel — dry-run of the fill gates: URL (Enter runs, Esc clears), optional session slug and entry filter in the URL, per-binding decision + reason chain (spec 04 §12.7) */
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { useApi } from '@/app/providers/AuthProvider.tsx';
import { Chip, VaultChip } from '@/components/shared/Chip.tsx';
import { DataPanel } from '@/components/shared/DataPanel.tsx';
import { EmptyState } from '@/components/shared/EmptyState.tsx';
import { SkeletonCard } from '@/components/shared/Skeletons.tsx';
import { TonePill } from '@/components/shared/StatusBadge.tsx';
import { useCursorPager } from '@/components/shared/use-cursor-pages.ts';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Label } from '@/components/ui/label.tsx';
import { useSearchState } from '@/lib/search/use-search-state.ts';
import type { Tone } from '@/lib/status-registry.ts';
import { useVaultBindings, useVaultGroups } from '../api.ts';
import type { VaultSearch } from '../search.ts';
import {
  type GateOutcome,
  normalizeTesterUrl,
  REASON_TEXT,
  type TesterDecision,
  testerDecisions,
} from './decide.ts';

const GATE_TONE: Record<GateOutcome, Tone> = { pass: 'success', fail: 'danger', skipped: 'muted' };

/** One decision with its reason chain. */
export function DecisionRow({ decision }: { readonly decision: TesterDecision }) {
  return (
    <li
      className="flex flex-col gap-2.5 rounded-xl border bg-card p-4 shadow-xs dark:shadow-none"
      aria-label={`${decision.handle}: ${decision.decision}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <VaultChip handle={decision.handle} />
        <TonePill
          entry={{
            label: decision.decision === 'fill' ? 'would fill' : 'blocked',
            tone: decision.decision === 'fill' ? 'success' : 'danger',
          }}
        />
        {decision.reason !== null ? (
          <span className="text-sm text-muted-foreground">
            <span className="font-mono">{decision.reason}</span> —{' '}
            {REASON_TEXT[decision.reason] ?? decision.reason}
          </span>
        ) : null}
      </div>
      <ol className="flex flex-wrap items-center gap-1.5 text-sm" aria-label="Reason chain">
        {decision.chain.map((gate, index) => (
          <li key={gate.gate} className="flex items-center gap-1">
            {index > 0 ? (
              <span aria-hidden="true" className="text-subtle-foreground">
                →
              </span>
            ) : null}
            <TonePill
              entry={{
                label: `${gate.gate}: ${gate.outcome}`,
                tone: GATE_TONE[gate.outcome],
                hint: gate.detail,
              }}
            />
          </li>
        ))}
      </ol>
    </li>
  );
}

/** The dry-run for the URL state (shared with the bindings table, which highlights `would_fill` handles). */
export function useTesterResult(search: Pick<VaultSearch, 'tester' | 'slug'>) {
  const api = useApi();
  const url = normalizeTesterUrl(search.tester ?? '');
  const slug = search.slug !== undefined && search.slug !== '' ? search.slug : undefined;
  const result = useQuery({
    queryKey: ['vault', 'tester', { url, slug }],
    queryFn: () =>
      api.resolveVaultBindings({
        body: { url: url ?? '', ...(slug !== undefined && { session_slug: slug }) },
      }),
    enabled: url !== null,
  });
  return { url, slug, result };
}

/** Tester panel. */
export function TesterPanel({ unlocked }: { readonly unlocked: boolean }) {
  const { search, set } = useSearchState<VaultSearch>();
  const ids = { url: useId(), slug: useId(), entry: useId() };
  const [draft, setDraft] = useState({
    url: search.tester ?? '',
    slug: search.slug ?? '',
    entry: search.entry ?? '',
  });
  useEffect(
    () =>
      setDraft({ url: search.tester ?? '', slug: search.slug ?? '', entry: search.entry ?? '' }),
    [search.tester, search.slug, search.entry],
  );
  const { url, slug, result } = useTesterResult(search);
  const pager = useCursorPager();
  const bindings = useVaultBindings({ limit: 500 }, 1, pager, url !== null);
  const groups = useVaultGroups(unlocked && url !== null);
  const run = (event: FormEvent) => {
    event.preventDefault();
    set({
      tester: draft.url.trim() || undefined,
      slug: draft.slug.trim() || undefined,
      entry: draft.entry.trim() || undefined,
      page: search.page,
    });
  };
  const clearAll = () =>
    set({ tester: undefined, slug: undefined, entry: undefined, page: search.page });
  return (
    <div className="flex flex-col gap-4">
      <form
        className="grid gap-3 rounded-xl border bg-card p-4 shadow-xs md:grid-cols-[2fr_1fr_1fr_auto] md:items-end dark:shadow-none"
        onSubmit={run}
        onKeyDown={(e) => (e.key === 'Escape' ? clearAll() : undefined)}
      >
        <div className="flex flex-col gap-1">
          <Label htmlFor={ids.url}>Page URL or host</Label>
          <Input
            id={ids.url}
            className="font-mono"
            placeholder="app.example.com/login"
            value={draft.url}
            onChange={(e) => setDraft({ ...draft, url: e.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={ids.slug}>Session slug</Label>
          <Input
            id={ids.slug}
            className="font-mono"
            placeholder="agent-1"
            value={draft.slug}
            onChange={(e) => setDraft({ ...draft, slug: e.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={ids.entry}>Entry</Label>
          <Input
            id={ids.entry}
            className="font-mono"
            placeholder="handle or item"
            value={draft.entry}
            onChange={(e) => setDraft({ ...draft, entry: e.target.value })}
          />
        </div>
        <div className="flex gap-2">
          <Button type="submit">Test</Button>
          {search.tester !== undefined ? (
            <Button type="button" variant="ghost" onClick={clearAll}>
              Clear
            </Button>
          ) : null}
        </div>
      </form>
      {search.tester !== undefined && url === null ? (
        <p role="alert" className="text-sm text-danger-text">
          “{search.tester}” is not a URL or host.
        </p>
      ) : null}
      {url === null ? (
        <EmptyState
          kind="zero-data"
          icon="search"
          size="sm"
          title="Dry-run a fill"
          description="Enter a page URL to see which bindings would fill there and why the others are blocked. Nothing is filled."
        />
      ) : (
        <DataPanel query={result} skeleton={<SkeletonCard />} isEmpty={() => false} empty={null}>
          {(data) => {
            const decisions = testerDecisions(data, {
              bindings: bindings.data?.data ?? [],
              groups: groups.data?.data ?? [],
              slug,
              entry: search.entry,
            });
            return (
              <div className="flex flex-col gap-2">
                <p className="flex flex-wrap items-center gap-2 text-sm">
                  {data.would_fill.length > 0
                    ? `${data.would_fill.length} binding${data.would_fill.length === 1 ? '' : 's'} would fill on`
                    : 'No binding allows an origin match for'}
                  <Chip className="font-mono">{new URL(url).host}</Chip>
                  {data.would_fill.length === 0 ? '— a fill on that host would be blocked.' : null}
                </p>
                {decisions.length === 0 ? (
                  <EmptyState
                    kind="zero-results"
                    title="No bindings match this entry filter"
                    onClear={() => set({ entry: undefined, page: search.page })}
                  />
                ) : (
                  <ul className="flex flex-col gap-2">
                    {decisions.map((d) => (
                      <DecisionRow key={d.handle} decision={d} />
                    ))}
                  </ul>
                )}
              </div>
            );
          }}
        </DataPanel>
      )}
    </div>
  );
}

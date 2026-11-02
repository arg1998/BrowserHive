/** @module features/vault/tester/TesterPanel — dry-run of the fill gates: URL (Enter runs, Esc clears), optional session slug, harness and declared name (D-48) and entry filter in the URL, per-binding decision + reason chain, and a note when harness lists were not checked (spec 04 §12.7) */

import { HARNESS_LABELS, harnessLabel, UNKNOWN_HARNESS } from '@browserhive/contracts/harness';
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { useApi } from '@/app/providers/AuthProvider.tsx';
import { Callout } from '@/components/shared/Callout.tsx';
import { Chip, VaultChip } from '@/components/shared/Chip.tsx';
import { DataPanel } from '@/components/shared/DataPanel.tsx';
import { EmptyState } from '@/components/shared/EmptyState.tsx';
import { SkeletonCard } from '@/components/shared/Skeletons.tsx';
import { TonePill } from '@/components/shared/StatusBadge.tsx';
import { useCursorPager } from '@/components/shared/use-cursor-pages.ts';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Label } from '@/components/ui/label.tsx';
import { SimpleSelect } from '@/components/ui/select.tsx';
import { useSearchState } from '@/lib/search/use-search-state.ts';
import type { Tone } from '@/lib/status-registry.ts';
import { useVaultBindings, useVaultGroups } from '../api.ts';
import { PICKABLE_HARNESSES } from '../harnesses/harness-rule.ts';
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
            {decision.reasonText ?? REASON_TEXT[decision.reason] ?? decision.reason}
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
export function useTesterResult(
  search: Pick<VaultSearch, 'tester' | 'slug' | 'harness' | 'declared'>,
) {
  const api = useApi();
  const url = normalizeTesterUrl(search.tester ?? '');
  const slug = search.slug !== undefined && search.slug !== '' ? search.slug : undefined;
  const harness = search.harness;
  const declared = search.declared;
  const result = useQuery({
    queryKey: ['vault', 'tester', { url, slug, harness, declared }],
    queryFn: () =>
      api.resolveVaultBindings({
        body: {
          url: url ?? '',
          ...(slug !== undefined && { session_slug: slug }),
          ...(harness !== undefined && { harness }),
          ...(declared !== undefined && { harness_declared: declared }),
        },
      }),
    enabled: url !== null,
  });
  return { url, slug, result };
}

/** "Any harness" in the select: harness lists are then not checked. */
const ANY_HARNESS = '';

/** The harness select: Any, the known harnesses, Unknown. */
const HARNESS_OPTIONS = [
  { value: ANY_HARNESS, label: 'Any harness' },
  ...PICKABLE_HARNESSES.map((slug) => ({ value: slug, label: HARNESS_LABELS[slug] })),
  { value: UNKNOWN_HARNESS, label: 'Unknown (not identified)' },
];

/** What the result is tested as, for the chain and the summary line. */
function testedAs(search: Pick<VaultSearch, 'harness' | 'declared'>): string | undefined {
  if (search.harness !== undefined) {
    const label = harnessLabel(search.harness);
    return search.declared === undefined ? label : `${label} (declared "${search.declared}")`;
  }
  return search.declared === undefined ? undefined : `"${search.declared}"`;
}

/** Tester panel. */
export function TesterPanel({ unlocked }: { readonly unlocked: boolean }) {
  const { search, set } = useSearchState<VaultSearch>();
  const ids = { url: useId(), slug: useId(), harness: useId(), declared: useId(), entry: useId() };
  const fromSearch = () => ({
    url: search.tester ?? '',
    slug: search.slug ?? '',
    harness: search.harness ?? ANY_HARNESS,
    declared: search.declared ?? '',
    entry: search.entry ?? '',
  });
  const [draft, setDraft] = useState(fromSearch);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-sync only when the URL state changes
  useEffect(
    () => setDraft(fromSearch()),
    [search.tester, search.slug, search.harness, search.declared, search.entry],
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
      harness: draft.harness === ANY_HARNESS ? undefined : draft.harness,
      declared: draft.declared.trim() || undefined,
      entry: draft.entry.trim() || undefined,
      page: search.page,
    });
  };
  const clearAll = () =>
    set({
      tester: undefined,
      slug: undefined,
      harness: undefined,
      declared: undefined,
      entry: undefined,
      page: search.page,
    });
  const asHarness = testedAs(search);
  return (
    <div className="flex flex-col gap-4">
      <form
        className="grid gap-x-3 gap-y-4 rounded-xl border bg-card p-4 shadow-xs sm:grid-cols-2 lg:grid-cols-4 dark:shadow-none"
        onSubmit={run}
        onKeyDown={(e) => (e.key === 'Escape' ? clearAll() : undefined)}
      >
        <div className="flex flex-col gap-1.5 sm:col-span-2 lg:col-span-3">
          <Label htmlFor={ids.url}>Page URL or host</Label>
          <Input
            id={ids.url}
            className="font-mono"
            placeholder="app.example.com/login"
            value={draft.url}
            onChange={(e) => setDraft({ ...draft, url: e.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1.5 sm:col-span-2 lg:col-span-1">
          <Label htmlFor={ids.entry}>Entry</Label>
          <Input
            id={ids.entry}
            className="font-mono"
            placeholder="handle or item"
            value={draft.entry}
            onChange={(e) => setDraft({ ...draft, entry: e.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={ids.slug}>Session slug</Label>
          <Input
            id={ids.slug}
            className="font-mono"
            placeholder="agent-1"
            value={draft.slug}
            onChange={(e) => setDraft({ ...draft, slug: e.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={ids.harness}>Harness</Label>
          <SimpleSelect
            id={ids.harness}
            className="w-full"
            value={draft.harness}
            options={HARNESS_OPTIONS}
            onValueChange={(value) => setDraft({ ...draft, harness: value })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={ids.declared}>Declared name</Label>
          <Input
            id={ids.declared}
            className="font-mono"
            placeholder="optional, exact"
            maxLength={64}
            autoComplete="off"
            spellCheck={false}
            aria-describedby={`${ids.declared}-hint`}
            value={draft.declared}
            onChange={(e) => setDraft({ ...draft, declared: e.target.value })}
          />
          <span id={`${ids.declared}-hint`} className="sr-only">
            The exact name the client declares; custom harness names are matched against it,
            case-sensitively.
          </span>
        </div>
        <div className="flex items-end gap-2">
          <Button type="submit" className="flex-1 sm:flex-none">
            Test
          </Button>
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
              harness: asHarness,
            });
            const unchecked = data.harness_lists_unchecked.length;
            return (
              <div className="flex flex-col gap-2">
                <p className="flex flex-wrap items-center gap-2 text-sm">
                  {data.would_fill.length > 0
                    ? `${data.would_fill.length} binding${data.would_fill.length === 1 ? '' : 's'} would fill on`
                    : 'No binding allows an origin match for'}
                  <Chip className="font-mono">{new URL(url).host}</Chip>
                  {data.would_fill.length === 0 ? '— a fill on that host would be blocked.' : null}
                  {asHarness !== undefined ? (
                    <span className="text-muted-foreground">as {asHarness}</span>
                  ) : null}
                </p>
                {unchecked > 0 ? (
                  <Callout tone="info" title="Harness lists were not checked">
                    {unchecked === 1 ? 'One binding has' : `${unchecked} bindings have`} a harness
                    list on the binding or its folder. Pick a harness above to test the lists as an
                    agent would be.
                  </Callout>
                ) : null}
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

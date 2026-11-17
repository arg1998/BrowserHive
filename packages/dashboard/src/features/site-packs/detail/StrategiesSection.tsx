/** @module features/site-packs/detail/StrategiesSection — the strategies a pack selects, as readable text (spec 13 §9.4, §11.4 `/site-packs/$id`): each strategy's title, kind and description from `GET /site-packs/strategies`, and every parameter with the value in force (the pack's, clamped to the binary's bounds, else the default), its default, its bounds and which way is stricter */
import type { SiteStrategyView } from '@browserhive/contracts/http';
import type { SitePackV1 } from '@browserhive/contracts/site-packs';
import { Chip } from '@/components/shared/Chip.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { useSiteStrategies } from '../api.ts';
import { Code, PackSection } from './PackSection.tsx';
import { type ParamRow, paramRows } from './strategy-model.ts';

type Selected = SitePackV1['strategies'][number];

/** Where a value comes from, in words (`null`: the pack sets it). */
function originText(row: ParamRow): string | null {
  switch (row.origin) {
    case 'default':
      return 'default';
    case 'pack':
      return 'from the pack’s settings';
    case 'clamped':
      return `the pack asks for ${row.raw ?? '—'}; kept within bounds`;
    case 'set':
      return null;
    default:
      return null;
  }
}

/** One parameter: name, value in force, and its default, bounds and direction. */
function ParamItem({ row }: { readonly row: ParamRow }) {
  const origin = originText(row);
  return (
    <li className="grid min-w-0 gap-x-4 gap-y-1 py-2.5 first:pt-0 last:pb-0 sm:grid-cols-[11rem_minmax(0,1fr)]">
      <span className="justify-self-start self-start">
        <Code>{row.name}</Code>
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span className="font-medium tabular-nums [overflow-wrap:anywhere]">{row.value}</span>
          {origin !== null ? (
            <span
              className={
                row.origin === 'clamped'
                  ? 'text-sm text-warn-text'
                  : 'text-sm text-muted-foreground'
              }
            >
              {origin}
            </span>
          ) : null}
        </span>
        <span className="text-sm text-muted-foreground text-pretty">
          Default {row.defaultText}
          {row.bounds !== null ? ` · Allowed ${row.bounds}` : ''} · {row.direction}
        </span>
      </div>
    </li>
  );
}

/** One selected strategy. */
function StrategyItem({
  selected,
  spec,
  pack,
}: {
  readonly selected: Selected;
  readonly spec: SiteStrategyView | undefined;
  readonly pack: SitePackV1;
}) {
  const rows = paramRows(spec?.params ?? [], selected.params, pack);
  return (
    <li
      data-strategy={selected.id}
      className="flex min-w-0 flex-col gap-2 py-4 first:pt-0 last:pb-0"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <h3 className="text-base font-semibold">{spec?.title ?? selected.id}</h3>
        {spec !== undefined ? (
          <Chip tone={spec.kind === 'stealth' ? 'info' : 'neutral'}>
            {spec.kind === 'stealth' ? 'Stealth' : 'Behaviour'}
          </Chip>
        ) : (
          <Chip tone="warn">Not known to this BrowserHive</Chip>
        )}
        <span className="font-mono text-xs text-muted-foreground">{selected.id}</span>
      </div>
      {spec !== undefined ? (
        <p className="max-w-3xl text-sm text-pretty text-muted-foreground">{spec.description}</p>
      ) : null}
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No parameters.</p>
      ) : (
        <ul
          aria-label={`${spec?.title ?? selected.id} parameters`}
          className="flex min-w-0 flex-col divide-y rounded-lg border px-3 py-2.5"
        >
          {rows.map((row) => (
            <ParamItem key={row.name} row={row} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** Strategies with their parameters from the binary's table. */
export function StrategiesSection({ pack }: { readonly pack: SitePackV1 }) {
  const query = useSiteStrategies();
  if (pack.strategies.length === 0) return null;
  const specs = new Map((query.data?.data ?? []).map((s) => [s.id, s]));
  return (
    <PackSection
      title={`Strategies (${pack.strategies.length})`}
      description="How BrowserHive behaves on this site, chosen from the strategies built into it. Numbers outside a strategy’s bounds are kept within them."
      docs="sitePacks"
    >
      {query.isPending ? (
        <div role="status" aria-busy="true" aria-label="Loading the strategies">
          <Skeleton className="h-24 rounded-lg" />
        </div>
      ) : (
        <ul aria-label="Strategies" className="flex min-w-0 flex-col divide-y">
          {pack.strategies.map((s) => (
            <StrategyItem key={s.id} selected={s} spec={specs.get(s.id)} pack={pack} />
          ))}
        </ul>
      )}
    </PackSection>
  );
}

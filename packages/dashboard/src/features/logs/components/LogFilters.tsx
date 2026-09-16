/** @module features/logs/components/LogFilters — the Logs toolbar controls that FilterBar does not provide: module menu, the "Dashboard traffic" switch, the compact phone Filters menu (levels, modules, dashboard traffic in one menu) and the Live / Resume toggle */
import type { LogLevel } from '@browserhive/contracts/enums';
import { useId } from 'react';
import { InfoDot } from '@/components/shared/InfoDot.tsx';
import { Button } from '@/components/ui/button.tsx';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx';
import { Switch } from '@/components/ui/switch.tsx';
import { Hint } from '@/components/ui/tooltip.tsx';
import { ICONS } from '@/lib/icons.ts';
import { cn } from '@/lib/utils.ts';
import { LOG_LEVELS } from '../log-filters.ts';

/** What "Dashboard traffic" means, shown behind the switch's info button. */
export const DASHBOARD_TRAFFIC_EXPLAINER =
  'Records an open dashboard produces just by being open: successful API reads (GET getMe 200) and realtime socket connects and disconnects. They are hidden by default so the tail shows what agents and the daemon actually do. Writes, failed requests, MCP calls and socket problems always show.';

/** Module roots offered by the module menu: everything seen so far plus the active filters. */
export function moduleOptions(seen: ReadonlySet<string>, selected: readonly string[]): string[] {
  return [...new Set([...seen, ...selected])].sort((a, b) => a.localeCompare(b));
}

function toggled<T>(list: readonly T[], value: T, on: boolean): readonly T[] | undefined {
  const next = on ? [...list, value] : list.filter((v) => v !== value);
  return next.length === 0 ? undefined : next;
}

function ModuleItems({
  options,
  selected,
  onChange,
}: {
  readonly options: readonly string[];
  readonly selected: readonly string[];
  readonly onChange: (next: readonly string[] | undefined) => void;
}) {
  return options.length === 0 ? (
    <p className="px-2 py-1.5 text-sm text-muted-foreground">No modules seen yet</p>
  ) : (
    options.map((module) => (
      <DropdownMenuCheckboxItem
        key={module}
        checked={selected.includes(module)}
        closeOnClick={false}
        onCheckedChange={(checked) => onChange(toggled(selected, module, checked))}
      >
        <span className="font-mono text-sm">{module}</span>
      </DropdownMenuCheckboxItem>
    ))
  );
}

/** Module filter (≥ 640px). */
export function ModuleMenu({
  options,
  selected,
  onChange,
}: {
  readonly options: readonly string[];
  readonly selected: readonly string[];
  readonly onChange: (next: readonly string[] | undefined) => void;
}) {
  const Chevron = ICONS.chevronDown;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="outline"
            className={cn(selected.length > 0 && 'border-accent-border')}
          />
        }
      >
        <span className="text-muted-foreground">Module</span>
        <span>
          {selected.length === 0
            ? 'All'
            : selected.length === 1
              ? selected[0]
              : `${selected.length} selected`}
        </span>
        <Chevron aria-hidden="true" className="text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Modules (with submodules)</DropdownMenuLabel>
          <ModuleItems options={options} selected={selected} onChange={onChange} />
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** "Dashboard traffic" switch with its explainer (≥ 640px). Off = hidden. */
export function DashboardTrafficSwitch({
  show,
  onChange,
}: {
  readonly show: boolean;
  readonly onChange: (show: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex h-9 items-center gap-2 pl-1">
      <Switch id={id} checked={show} onCheckedChange={(checked) => onChange(checked)} />
      <label htmlFor={id} className="cursor-pointer text-base whitespace-nowrap select-none">
        Dashboard traffic
      </label>
      <InfoDot label="About dashboard traffic">{DASHBOARD_TRAFFIC_EXPLAINER}</InfoDot>
    </div>
  );
}

/** Phone filters: levels, modules and dashboard traffic in one menu behind a "Filters" button. */
export function FiltersMenu({
  levels,
  onLevelsChange,
  modules,
  moduleChoices,
  onModulesChange,
  showReads,
  onShowReadsChange,
  readsLocked,
}: {
  readonly levels: readonly LogLevel[];
  readonly onLevelsChange: (next: readonly LogLevel[] | undefined) => void;
  readonly modules: readonly string[];
  readonly moduleChoices: readonly string[];
  readonly onModulesChange: (next: readonly string[] | undefined) => void;
  readonly showReads: boolean;
  readonly onShowReadsChange: (show: boolean) => void;
  /** A request or trace filter is active: every record of it shows, so the switch is moot. */
  readonly readsLocked: boolean;
}) {
  const Filter = ICONS.filter;
  const active = levels.length + modules.length + (showReads && !readsLocked ? 1 : 0);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="outline"
            className={cn(active > 0 && 'border-accent-border')}
          />
        }
      >
        <Filter aria-hidden="true" className="text-muted-foreground" />
        Filters
        {active > 0 ? (
          <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-accent-bg px-1.5 text-xs font-medium text-accent-text tabular-nums">
            {active}
          </span>
        ) : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[min(28rem,70dvh)] w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Levels</DropdownMenuLabel>
          {LOG_LEVELS.map((level) => (
            <DropdownMenuCheckboxItem
              key={level}
              checked={levels.includes(level)}
              closeOnClick={false}
              onCheckedChange={(checked) => onLevelsChange(toggled(levels, level, checked))}
            >
              {level}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>Modules</DropdownMenuLabel>
          <ModuleItems options={moduleChoices} selected={modules} onChange={onModulesChange} />
        </DropdownMenuGroup>
        {readsLocked ? null : (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuCheckboxItem
                checked={showReads}
                closeOnClick={false}
                onCheckedChange={(checked) => onShowReadsChange(checked)}
              >
                Show dashboard traffic
              </DropdownMenuCheckboxItem>
              <p className="px-2 pb-1.5 text-sm text-pretty text-muted-foreground">
                API reads and socket connects from open dashboards.
              </p>
            </DropdownMenuGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Live / Resume. While tailing it reads "Live" (click pauses); while paused it reads "Resume". */
export function LiveToggle({
  live,
  onToggle,
}: {
  readonly live: boolean;
  readonly onToggle: () => void;
}) {
  const Play = ICONS.play;
  return (
    <Hint label={live ? 'Pause the tail; new records are held' : 'Resume the live tail'}>
      <Button
        type="button"
        variant="outline"
        aria-label={live ? 'Live, pause the tail' : 'Resume the live tail'}
        className={cn(
          live &&
            'border-accent-border bg-accent-bg text-accent-text hover:bg-accent-bg-hover dark:bg-accent-bg dark:hover:bg-accent-bg-hover',
        )}
        onClick={onToggle}
      >
        {live ? (
          <span aria-hidden="true" className="relative flex size-2">
            <span className="absolute inset-0 animate-ping rounded-full bg-success-solid opacity-60 motion-reduce:hidden" />
            <span className="relative size-2 rounded-full bg-success-solid" />
          </span>
        ) : (
          <Play aria-hidden="true" />
        )}
        {live ? 'Live' : 'Resume'}
      </Button>
    </Hint>
  );
}

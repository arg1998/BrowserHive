/** @module features/templates/SiteChips — a site with its sign-in health: an icon whose shape and colour carry the state (signed in, signed out, check needed, couldn't tell, not checked) beside the domain; `SiteChips` shows a row's sites and folds the rest into "+N" */
import type { TemplateHealthState } from '@browserhive/contracts/enums';
import { TONE_CLASSES } from '@/components/shared/tones.ts';
import { ICONS } from '@/lib/icons.ts';
import { SITE_HEALTH } from '@/lib/status-registry.ts';
import { cn } from '@/lib/utils.ts';
import { HEALTH_ICON } from './model.ts';

/** The health icon alone (screen readers get the label). */
export function HealthIcon({
  state,
  className,
}: {
  readonly state: TemplateHealthState;
  readonly className?: string;
}) {
  const entry = SITE_HEALTH[state];
  const Icon = ICONS[HEALTH_ICON[state]];
  return (
    <Icon
      aria-hidden="true"
      className={cn('size-3.5 shrink-0', TONE_CLASSES[entry.tone].text, className)}
    />
  );
}

/** One site: health icon + domain; the state is read out after the domain. */
export function SiteChip({
  site,
  state,
  className,
}: {
  readonly site: string;
  readonly state: TemplateHealthState;
  readonly className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex h-6 max-w-full min-w-0 items-center gap-1.5 rounded-md border border-border bg-background/60 px-2 text-sm text-foreground dark:bg-white/[0.03]',
        className,
      )}
    >
      <HealthIcon state={state} />
      <span className="truncate">{site}</span>
      <span className="sr-only">: {SITE_HEALTH[state].label}</span>
    </span>
  );
}

/** A row's sites: up to `max` chips, then "+N more". */
export function SiteChips({
  sites,
  max = 3,
  className,
}: {
  readonly sites: readonly {
    readonly site_id: string;
    readonly health_state: TemplateHealthState;
  }[];
  readonly max?: number;
  readonly className?: string;
}) {
  const shown = sites.slice(0, max);
  const rest = sites.length - shown.length;
  return (
    <span className={cn('flex min-w-0 flex-wrap items-center gap-1', className)}>
      {shown.map((site) => (
        <SiteChip key={site.site_id} site={site.site_id} state={site.health_state} />
      ))}
      {rest > 0 ? <span className="text-sm text-muted-foreground">+{rest} more</span> : null}
    </span>
  );
}

/** @module features/templates/ReloginSitePicker — the site choice of Re-login… when the template has several (radio cards with each site's sign-in state) */
import type { TemplateSiteView } from '@browserhive/contracts/http';
import { useId } from 'react';
import { SITE_HEALTH } from '@/lib/status-registry.ts';
import { cn } from '@/lib/utils.ts';
import { HealthIcon } from './SiteChips.tsx';

/** Choose the site (radio cards, one per site). */
export function ReloginSitePicker({
  sites,
  value,
  onChange,
}: {
  readonly sites: readonly TemplateSiteView[];
  readonly value: string;
  readonly onChange: (site: string) => void;
}) {
  const name = useId();
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1.5 text-sm font-medium">Site</legend>
      {sites.map((site) => (
        <label
          key={site.site_id}
          className={cn(
            'flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors hover:bg-accent/60 has-focus-visible:ring-2 has-focus-visible:ring-ring/60',
            value === site.site_id && 'border-primary bg-primary/5 hover:bg-primary/10',
          )}
        >
          <input
            type="radio"
            name={name}
            value={site.site_id}
            checked={value === site.site_id}
            onChange={() => onChange(site.site_id)}
            className="size-4 accent-primary"
          />
          <HealthIcon state={site.health.state} className="size-4" />
          <span className="min-w-0 flex-1 truncate font-medium">{site.title}</span>
          <span className="shrink-0 text-sm text-muted-foreground">
            {SITE_HEALTH[site.health.state].label}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

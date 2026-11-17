/** @module features/templates/detail/ProbeRow — one sign-in check on the Activity tab: the site and what the check found (icon and words), why, why it ran, how long it took, the page it ended on (sanitized), and when */
import type { TemplateProbeRow } from '@browserhive/contracts/http';
import { Chip } from '@/components/shared/Chip.tsx';
import { RelativeTime } from '@/components/shared/RelativeTime.tsx';
import { splitUrl } from '@/components/shared/url-cell.tsx';
import { formatMs } from '@/lib/format/time.ts';
import { SITE_HEALTH } from '@/lib/status-registry.ts';
import { healthReasonText } from '../model.ts';
import { PROBE_TRIGGER_LABEL } from '../relogin-text.ts';
import { HealthIcon } from '../SiteChips.tsx';

/** One check. */
export function ProbeRow({
  row,
  title,
}: {
  readonly row: TemplateProbeRow;
  readonly title: string;
}) {
  const url = row.final_url === null ? null : splitUrl(row.final_url);
  return (
    <li
      data-outcome={row.outcome}
      className="flex min-w-0 flex-col gap-1.5 px-5 py-3.5 sm:flex-row sm:items-start sm:gap-6"
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <HealthIcon state={row.outcome} className="mt-1 size-4" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <span className="font-medium">{title}</span>
            <span className="text-muted-foreground">{SITE_HEALTH[row.outcome].label}</span>
          </p>
          <p className="text-sm text-pretty text-foreground/85">{healthReasonText(row.reason)}</p>
          {url !== null ? (
            <p className="truncate font-mono text-xs text-muted-foreground">
              <span className="text-foreground/75">{url.host}</span>
              {url.rest}
            </p>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 pl-7 text-sm text-muted-foreground sm:flex-col sm:items-end sm:gap-1 sm:pl-0">
        <RelativeTime at={row.at} className="text-sm sm:text-right" />
        <span className="flex items-center gap-2">
          <Chip>{PROBE_TRIGGER_LABEL[row.trigger]}</Chip>
          <span className="tabular-nums">{formatMs(row.duration_ms)}</span>
        </span>
      </div>
    </li>
  );
}

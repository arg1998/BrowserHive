/** @module features/templates/detail/VersionRow — one version on the Versions tab: number, why it was written, Last good / Pinned / unreadable, age, size and author, cookies per domain (names only), each site's sign-in when written, Restore… and Pin */
import type { TemplateVersionRow } from '@browserhive/contracts/http';
import { Chip } from '@/components/shared/Chip.tsx';
import { RelativeTime } from '@/components/shared/RelativeTime.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Hint } from '@/components/ui/tooltip.tsx';
import { formatBytes } from '@/lib/format/bytes.ts';
import { ICONS } from '@/lib/icons.ts';
import { SITE_HEALTH } from '@/lib/status-registry.ts';
import { HealthIcon } from '../SiteChips.tsx';
import { reasonText, summaryLines } from './version-text.ts';

/** One version. */
export function VersionRow({
  row,
  onRestore,
  onPin,
  pinning,
}: {
  readonly row: TemplateVersionRow;
  readonly onRestore: () => void;
  readonly onPin: () => void;
  readonly pinning: boolean;
}) {
  const Pin = row.pinned ? ICONS.unpin : ICONS.pin;
  const lines = summaryLines(row.summary);
  const restore = (
    <Button type="button" size="xs" variant="outline" disabled={!row.readable} onClick={onRestore}>
      <ICONS.restore aria-hidden="true" />
      Restore…
    </Button>
  );
  return (
    <li className="flex min-w-0 flex-col gap-2 px-5 py-4 sm:flex-row sm:items-start sm:gap-6">
      <div className="flex max-w-3xl min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="font-semibold tabular-nums">Version {row.version}</span>
          <span className="text-muted-foreground">{reasonText(row)}</span>
          {row.last_good ? <Chip tone="success">Last good</Chip> : null}
          {row.pinned ? <Chip tone="info">Pinned</Chip> : null}
          {row.readable ? null : <Chip tone="danger">Unreadable with the current key</Chip>}
        </div>
        <p className="text-sm text-muted-foreground">
          <RelativeTime at={row.created_at} className="min-w-0 text-sm" /> ·{' '}
          {formatBytes(row.size_bytes)}
          {row.created_by !== null && row.created_by !== 'browserhive'
            ? ` · ${row.created_by}`
            : ' · automatic'}
        </p>
        {lines.length > 0 ? (
          <ul className="flex flex-col gap-0.5 text-sm text-foreground/85">
            {lines.map((line) => (
              <li key={line} className="[overflow-wrap:anywhere]">
                {line}
              </li>
            ))}
          </ul>
        ) : null}
        <ul aria-label="Sign-in when written" className="flex flex-wrap gap-x-4 gap-y-1">
          {row.health.map((site) => (
            <li key={site.site_id} className="flex items-center gap-1 text-sm">
              <HealthIcon state={site.state} />
              <span>{site.site_id}</span>
              <span className="text-muted-foreground">
                {SITE_HEALTH[site.state].label.toLowerCase()}
                {site.sign_in_complete === false ? ', some sign-in cookies missing' : ''}
                {site.enabled ? '' : ', not offered'}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {row.readable ? (
          restore
        ) : (
          <Hint label="This version was saved with a key this server does not hold">
            {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a disabled button cannot take focus, so its wrapper carries the tooltip reason */}
            <span tabIndex={0} className="rounded-md focus-ring">
              {restore}
            </span>
          </Hint>
        )}
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={pinning}
          aria-pressed={row.pinned}
          aria-label={`${row.pinned ? 'Unpin' : 'Pin'} version ${row.version}`}
          onClick={onPin}
        >
          <Pin aria-hidden="true" />
          {row.pinned ? 'Unpin' : 'Pin'}
        </Button>
      </div>
    </li>
  );
}

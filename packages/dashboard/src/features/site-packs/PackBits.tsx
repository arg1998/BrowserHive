/** @module features/site-packs/PackBits — small pieces every pack surface shares (wizard, template Sites tab, Site packs pages): the short SHA-256 with a copy button, the stance label ("What the site's terms say"), the terms clause quoted verbatim with its checked date and its URL as plain text with the domain shown (never a link, spec 13 §9.3), the "Local file overrides vN" badge and the local-file state pill */
import type { SitePackView } from '@browserhive/contracts/http';
import { Chip } from '@/components/shared/Chip.tsx';
import { CopyButton } from '@/components/shared/CopyButton.tsx';
import { TonePill } from '@/components/shared/StatusBadge.tsx';
import { cn } from '@/lib/utils.ts';
import { domainOf, LOCAL_STATE, STANCE_TEXT, STANCE_TONE, type Stance, shortSha } from './model.ts';

/** `3f9a1c0b7e2d…` with a copy button for the full digest. */
export function ShaText({
  sha256,
  className,
  copy = true,
}: {
  readonly sha256: string;
  readonly className?: string;
  readonly copy?: boolean;
}) {
  return (
    <span data-reveal-scope="" className={cn('inline-flex min-w-0 items-center gap-1', className)}>
      <span className="font-mono text-sm tabular-nums" title={sha256}>
        <span className="sr-only">SHA-256 </span>
        {shortSha(sha256)}…
      </span>
      {copy ? (
        <CopyButton value={sha256} label="Copy the full SHA-256" visibility="always" />
      ) : null}
    </span>
  );
}

/** The terms' stance as a label. */
export function StanceLabel({ stance }: { readonly stance: Stance }) {
  return (
    <TonePill
      entry={{ label: STANCE_TEXT[stance], tone: STANCE_TONE[stance] }}
      iconless
      className="h-auto min-h-5.5 py-0.5 whitespace-normal"
    />
  );
}

/** A terms clause, verbatim, with its checked date and its address as text. */
export function TermsClause({
  clause,
}: {
  readonly clause: { readonly quote: string; readonly url: string; readonly checked: string };
}) {
  const domain = domainOf(clause.url);
  return (
    <figure className="flex min-w-0 flex-col gap-1.5">
      <blockquote className="border-l-2 border-border pl-3 text-base text-pretty italic [overflow-wrap:anywhere]">
        “{clause.quote}”
      </blockquote>
      <figcaption className="flex min-w-0 flex-col gap-0.5 text-sm text-muted-foreground">
        <span>Checked {clause.checked}</span>
        <span className="min-w-0 [overflow-wrap:anywhere]">
          {domain !== null ? (
            <>
              On <span className="font-medium text-foreground">{domain}</span>:{' '}
            </>
          ) : null}
          <span className="font-mono text-xs select-all">{clause.url}</span>
        </span>
      </figcaption>
    </figure>
  );
}

/** "Local file overrides v9" (spec 13 §9.6 precedence). */
export function LocalOverrideBadge({ version }: { readonly version: number | null }) {
  return (
    <Chip tone="info" className="shrink-0">
      {version === null ? 'Local file in force' : `Local file overrides v${version}`}
    </Chip>
  );
}

/** A local file's state as a pill. */
export function LocalStatePill({ local }: { readonly local: NonNullable<SitePackView['local']> }) {
  const state = LOCAL_STATE[local.state];
  return <TonePill entry={{ label: state.label, tone: state.tone }} iconless />;
}

/** An address as plain text with its domain shown first (never a link, spec 13 §9.3). */
export function UrlText({ url, className }: { readonly url: string; readonly className?: string }) {
  const domain = domainOf(url);
  return (
    <span className={cn('min-w-0 [overflow-wrap:anywhere]', className)}>
      {domain !== null ? <span className="font-medium">{domain}</span> : null}
      {domain !== null ? ' · ' : null}
      <span className="font-mono text-xs text-muted-foreground select-all">{url}</span>
    </span>
  );
}

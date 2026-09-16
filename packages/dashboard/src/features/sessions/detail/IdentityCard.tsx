/** @module features/sessions/detail/IdentityCard — applied identity body for the Details tab: coherence state, full user agent (copy), UA-CH brands, platform, Chrome, mechanisms, locale + seed, timezone, screen @DPR, viewport; the tense-aware fallback copy when none was applied (spec 04 §12.3.4) */
import type { SessionSummary } from '@browserhive/contracts/http';
import { Chip } from '@/components/shared/Chip.tsx';
import { CopyValue } from '@/components/shared/CopyButton.tsx';
import { KeyValue, type KeyValueItem } from '@/components/shared/KeyValue.tsx';
import { TonePill } from '@/components/shared/StatusBadge.tsx';
import { identityChip, identityFallback, identityProvenance, parseIdentity } from './identity.ts';

/** Identity body (the surrounding panel owns the title). */
export function IdentityCard({ session }: { readonly session: SessionSummary }) {
  const identity = parseIdentity(session.identity);
  const chip = identityChip(session, identity);
  const head =
    chip === 'host-coherent' ? (
      <TonePill entry={{ label: 'host-coherent', tone: 'success', icon: 'check' }} />
    ) : (
      <Chip tone="muted">{chip}</Chip>
    );
  if (identity === null) {
    return (
      <div className="flex flex-col items-start gap-3">
        {head}
        <p className="text-sm text-muted-foreground">{identityFallback(session)}</p>
      </div>
    );
  }
  const items: KeyValueItem[] = [
    {
      key: 'UA-CH brands',
      mono: true,
      value: identity.brands.map((b) => `${b.brand} ${b.version}`).join(', ') || '—',
    },
    { key: 'Platform', value: identity.platform || '—' },
    { key: 'Chrome', mono: true, value: identity.chromeMajor || '—' },
    {
      key: 'Mechanisms',
      value: `fingerprint ${session.fingerprint ? 'on' : 'off'} · humanize ${session.humanize ? 'on' : 'off'}`,
    },
  ];
  if (identity.geo !== null) {
    items.push(
      {
        key: 'Locale',
        value: (
          <span className="inline-flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm">{identity.geo.languages.join(', ')}</span>
            <Chip tone="muted">
              {identity.geo.source === 'host' ? 'host-seeded' : 'proxy-seeded'}
            </Chip>
          </span>
        ),
      },
      { key: 'Timezone', mono: true, value: identity.geo.timezoneId },
    );
  }
  if (identity.display !== null) {
    const { screen, viewport, deviceScaleFactor } = identity.display;
    items.push(
      {
        key: 'Screen',
        mono: true,
        value: `${screen.width}×${screen.height} @${deviceScaleFactor}×`,
      },
      { key: 'Viewport', mono: true, value: `${viewport.width}×${viewport.height}` },
    );
  }
  if (session.proxy_label !== null) items.push({ key: 'Proxy', value: session.proxy_label });
  return (
    <div className="flex flex-col items-start gap-4">
      {head}
      {/* The user agent is long: it gets the full width instead of a narrow value column. */}
      <div className="flex w-full min-w-0 flex-col gap-1">
        <span className="text-sm text-muted-foreground">User agent</span>
        <CopyValue
          value={identity.userAgent}
          label="Copy user agent"
          display={
            <span className="font-mono text-sm [overflow-wrap:break-word] whitespace-normal">
              {identity.userAgent}
            </span>
          }
          className="items-start"
        />
      </div>
      <KeyValue items={items} className="w-full" />
      <p className="text-sm text-muted-foreground">{identityProvenance(session, identity)}</p>
    </div>
  );
}

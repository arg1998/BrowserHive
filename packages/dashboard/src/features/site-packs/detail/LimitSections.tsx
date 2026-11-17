/** @module features/site-packs/detail/LimitSections — the rest of a pack as readable text (spec 13 §9.2, §9.4): sessions at once and pacing with their official or vendor label and source, the browser and consistency the site expects, device binding, the strategies with their parameters listed as data (they apply from a later release), the verified dates and the sources as text with the domain shown */
import type { SitePackV1 } from '@browserhive/contracts/site-packs';
import { Chip } from '@/components/shared/Chip.tsx';
import { UrlText } from '../PackBits.tsx';
import { PER_LABEL, SECTION_LABEL, SOURCE_KIND_LABEL } from './labels.ts';
import { Code, Facts, PackSection } from './PackSection.tsx';

type Source = SitePackV1['sources'][number];

function SourceLine({ source }: { readonly source: Source }) {
  return (
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <Chip tone={source.kind === 'official' ? 'info' : 'neutral'}>
        {SOURCE_KIND_LABEL[source.kind]}
      </Chip>
      <UrlText url={source.url} className="text-sm" />
    </span>
  );
}

/** Concurrency and pacing. */
export function PacingSection({ pack }: { readonly pack: SitePackV1 }) {
  const rules = pack.pacing?.rules ?? [];
  const gap = pack.pacing?.min_launch_gap_s ?? 0;
  if (pack.concurrency === undefined && rules.length === 0 && gap === 0) return null;
  return (
    <PackSection title="Sessions and pacing">
      <Facts
        rows={[
          pack.concurrency !== undefined && [
            'Sessions at once',
            <span key="c" className="flex flex-col gap-1">
              <span>At most {pack.concurrency.max_sessions}</span>
              <SourceLine source={pack.concurrency.source} />
            </span>,
          ],
          gap > 0 && ['Between launches', `At least ${gap} s`],
          ...rules.map(
            (rule) =>
              [
                `Pace: ${rule.guard}`,
                <span key={rule.id} className="flex flex-col gap-1">
                  <span>
                    At most {rule.limit} per {PER_LABEL[rule.per]}{' '}
                    <span className="text-sm text-muted-foreground">
                      ({rule.kind === 'official' ? 'official limit' : 'vendor guidance'})
                    </span>
                  </span>
                  <SourceLine source={rule.source} />
                </span>,
              ] as const,
          ),
        ]}
      />
    </PackSection>
  );
}

/** Browser, consistency and device binding. */
export function BrowserSection({ pack }: { readonly pack: SitePackV1 }) {
  const c = pack.consistency;
  const pins = [c.pin_geo && 'location', c.pin_timezone && 'time zone', c.pin_locale && 'language']
    .filter((s): s is string => typeof s === 'string')
    .join(', ');
  return (
    <PackSection title="What the site expects">
      <Facts
        rows={[
          [
            'Browser',
            pack.browser.channel === 'any' ? 'Any Chromium browser' : pack.browser.channel,
          ],
          [
            'Window',
            pack.browser.headed === 'required'
              ? 'A visible browser is required'
              : pack.browser.headed === 'preferred'
                ? 'A visible browser is preferred'
                : 'Visible or headless',
          ],
          ['Kept the same', pins === '' ? 'Nothing pinned' : pins],
          ['Proxy', c.proxy === 'recommended' ? 'Recommended' : 'Not needed'],
          ...pack.device_binding.map(
            (d) =>
              [
                `Device binding (${d.platform})`,
                <span key={`${d.platform}-${d.mechanism}`} className="flex flex-col gap-1">
                  <span>
                    {d.mechanism === 'dbsc'
                      ? 'Device-bound session credentials'
                      : d.mechanism === 'ip'
                        ? 'Tied to the IP address'
                        : 'A device cookie'}
                    {d.since !== undefined ? ` since ${d.since}` : ''}
                  </span>
                  <SourceLine source={d.source} />
                </span>,
              ] as const,
          ),
        ]}
      />
    </PackSection>
  );
}

/** Strategies: listed as data; they apply from a later release (T3b). */
export function StrategiesSection({ pack }: { readonly pack: SitePackV1 }) {
  if (pack.strategies.length === 0) return null;
  return (
    <PackSection
      title={`Strategies (${pack.strategies.length})`}
      description="Behaviours this pack selects from the set built into BrowserHive. They are stored and shown now and applied from a later release."
    >
      <ul className="flex flex-col divide-y">
        {pack.strategies.map((s) => {
          const params = Object.entries(s.params);
          return (
            <li key={s.id} className="flex min-w-0 flex-col gap-1 py-2.5 first:pt-0 last:pb-0">
              <span className="font-mono text-sm font-medium">{s.id}</span>
              {params.length === 0 ? (
                <span className="text-sm text-muted-foreground">Default parameters</span>
              ) : (
                <span className="flex flex-wrap gap-1.5">
                  {params.map(([name, value]) => (
                    <Code key={name}>
                      {name} = {String(value)}
                    </Code>
                  ))}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </PackSection>
  );
}

/** Verified dates and sources. */
export function ProvenanceSection({ pack }: { readonly pack: SitePackV1 }) {
  const verified = Object.entries(pack.verified);
  return (
    <PackSection
      title="Verified and sources"
      description="Sources are listed for you to check; BrowserHive never opens them."
    >
      <Facts
        rows={[
          [
            'Verified',
            verified.length === 0 ? (
              'No section is marked verified'
            ) : (
              <ul key="v" className="flex flex-col gap-0.5">
                {verified.map(([section, date]) => (
                  <li key={section}>
                    {SECTION_LABEL[section] ?? section}: {date}
                  </li>
                ))}
              </ul>
            ),
          ],
          pack.sources.length > 0 && [
            'Sources',
            <ul key="s" className="flex flex-col gap-1.5">
              {pack.sources.map((s) => (
                <li key={s.url}>
                  <SourceLine source={s} />
                </li>
              ))}
            </ul>,
          ],
          [
            'Needs BrowserHive',
            `${pack.min_client} or later${pack.max_client !== undefined ? `, up to ${pack.max_client}` : ''}`,
          ],
        ]}
      />
    </PackSection>
  );
}

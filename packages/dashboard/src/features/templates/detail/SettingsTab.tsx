/** @module features/templates/detail/SettingsTab — the Settings tab (spec 13 §2.2, §11.4): the pinned identity (read-only: a different identity is a different template), what the first browser start recorded, the editable browser, network and check settings, and the data directory */
import type { TemplateDetailResponse } from '@browserhive/contracts/http';
import { KeyValue, type KeyValueItem } from '@/components/shared/KeyValue.tsx';
import { Panel } from '@/components/shared/Section.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { formatAbsolute } from '@/lib/format/time.ts';
import { ICONS } from '@/lib/icons.ts';
import { useTemplateOperations } from '../api-operations.ts';
import { BrowserSettings } from './BrowserSettings.tsx';

/** Technical values most operators never need, behind a disclosure. */
function MoreDetails({ items }: { readonly items: readonly KeyValueItem[] }) {
  return (
    <details className="group mt-3 border-t pt-3">
      <summary className="w-fit cursor-pointer rounded-sm text-sm font-medium text-muted-foreground focus-ring hover:text-foreground">
        Details
      </summary>
      <KeyValue className="mt-3" items={items} />
    </details>
  );
}

/** Settings tab. */
export function SettingsTab({ detail }: { readonly detail: TemplateDetailResponse }) {
  const { template } = detail;
  const { identity, identity_observed: observed } = template;
  const ops = useTemplateOperations(template.template_id);
  const revealed = ops.reveal.data;
  const geo = identity.geolocation;
  return (
    <div className="grid min-w-0 items-start gap-4 xl:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-4">
        <Panel
          title="Identity"
          description="Fixed when the template was created, so sites always see the same person on the same device."
        >
          <KeyValue
            items={[
              { key: 'Language', value: identity.locale },
              { key: 'Time zone', value: identity.timezone_id },
              { key: 'Country', value: identity.country_code ?? 'Not set' },
              {
                key: 'Location',
                value:
                  geo === undefined
                    ? 'Not set'
                    : `${geo.latitude.toFixed(4)}, ${geo.longitude.toFixed(4)}`,
              },
            ]}
          />
          <MoreDetails
            items={[
              { key: 'Languages sent', value: identity.languages.join(', ') },
              { key: 'Fingerprint seed', value: identity.seed, mono: true },
            ]}
          />
        </Panel>
        <Panel
          title="Recorded from the browser"
          description="What the browser itself reported; never faked."
        >
          {observed === null ? (
            <p className="text-base text-muted-foreground">Recorded at the first start.</p>
          ) : (
            <KeyValue
              items={[
                { key: 'Chrome', value: observed.chrome_major },
                {
                  key: 'Platform',
                  value: `${observed.ua_ch.platform} ${observed.ua_ch.platform_version}`,
                },
                {
                  key: 'Screen',
                  value: `${observed.screen.width} × ${observed.screen.height} @${observed.screen.device_scale_factor}x`,
                },
                { key: 'Window', value: `${observed.window.width} × ${observed.window.height}` },
                { key: 'Recorded', value: formatAbsolute(observed.observed_at) },
              ]}
            />
          )}
          {observed !== null ? (
            <MoreDetails
              items={[
                { key: 'User agent', value: observed.user_agent, mono: true },
                {
                  key: 'Brands',
                  value: observed.ua_ch.brands.map((b) => `${b.brand} ${b.version}`).join(', '),
                },
                {
                  key: 'Architecture',
                  value: `${observed.ua_ch.architecture} · ${observed.ua_ch.bitness}-bit`,
                },
              ]}
            />
          ) : null}
        </Panel>
        <Panel
          title="Data directory"
          description="The browser profile, versions and downloads of this template."
        >
          <div className="flex flex-col gap-2">
            <div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={ops.reveal.isPending}
                onClick={() => ops.reveal.mutate()}
              >
                {ops.reveal.isPending ? <Spinner /> : <ICONS.folder aria-hidden="true" />}
                Show in file manager
              </Button>
            </div>
            {revealed !== undefined ? (
              <p className="text-sm text-muted-foreground">
                <span className="font-mono [overflow-wrap:anywhere]">{revealed.path}</span>
                {revealed.opened
                  ? ' · opened'
                  : revealed.detail !== undefined
                    ? ` · ${revealed.detail}`
                    : ''}
              </p>
            ) : null}
          </div>
        </Panel>
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        <BrowserSettings template={template} />
      </div>
    </div>
  );
}

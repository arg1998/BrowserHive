/** @module features/templates/detail/HealthPanel — the Sign-in checks panel of the Settings tab (spec 13 §8): how often the sites are checked and whether they are checked before a launch; each change saves at once with a toast */
import type { Template } from '@browserhive/contracts/http';
import { useId } from 'react';
import { Panel } from '@/components/shared/Section.tsx';
import { SimpleSelect } from '@/components/ui/select.tsx';
import { Switch } from '@/components/ui/switch.tsx';
import { Field } from './settings-field.tsx';
import { HEALTH_INTERVALS, policyWith } from './settings-patch.ts';
import { useSaveTemplate } from './use-save-template.ts';

/** Sign-in checks panel. */
export function HealthPanel({ template }: { readonly template: Template }) {
  const { save, saving } = useSaveTemplate(template);
  const intervalId = useId();
  const prelaunchId = useId();
  const { policy } = template;
  const options = HEALTH_INTERVALS.some((o) => o.ms === policy.health_interval_ms)
    ? HEALTH_INTERVALS
    : [
        ...HEALTH_INTERVALS,
        {
          ms: policy.health_interval_ms,
          label: `Every ${Math.round(policy.health_interval_ms / 60_000)} minutes`,
        },
      ];
  return (
    <Panel
      title="Sign-in checks"
      description="How BrowserHive makes sure the sites are still signed in."
    >
      <div className="flex flex-col gap-5">
        <Field label="Check" htmlFor={intervalId}>
          <SimpleSelect
            id={intervalId}
            size="sm"
            className="w-48"
            value={String(policy.health_interval_ms)}
            disabled={saving}
            options={options.map((o) => ({ value: String(o.ms), label: o.label }))}
            onValueChange={(value) =>
              void save(
                policyWith(policy, { health_interval_ms: Number(value) }),
                'Check interval changed',
              )
            }
          />
        </Field>
        <Field
          label="Before a launch"
          htmlFor={prelaunchId}
          hint="Checks the sites before handing a session to an agent."
        >
          <div className="flex items-center gap-3 sm:pt-1.5">
            <Switch
              id={prelaunchId}
              checked={policy.prelaunch_check}
              disabled={saving}
              onCheckedChange={(on: boolean) =>
                void save(
                  policyWith(policy, { prelaunch_check: on }),
                  on ? 'Pre-launch check on' : 'Pre-launch check off',
                )
              }
            />
            <span className="text-base">{policy.prelaunch_check ? 'On' : 'Off'}</span>
          </div>
        </Field>
      </div>
    </Panel>
  );
}

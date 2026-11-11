/** @module features/templates/detail/BrowserSettings — the editable part of the Settings tab (spec 13 §2.1–§2.2, §11.4): the browser (channel, headless with its warning, agent windows), the network (the pinned proxy; changing it or the channel restarts the browser and may sign the accounts out, so it is confirmed) and health checks (interval, pre-launch check) */

import { Channel } from '@browserhive/contracts/enums';
import type { Template } from '@browserhive/contracts/http';
import { AgentWindows } from '@browserhive/contracts/http';
import { useId } from 'react';
import { Callout } from '@/components/shared/Callout.tsx';
import { Panel } from '@/components/shared/Section.tsx';
import { SimpleSelect } from '@/components/ui/select.tsx';
import { Switch } from '@/components/ui/switch.tsx';
import { identityChangeConfirm } from '../confirm-copy.ts';
import { CHANNEL_LABEL } from '../model.ts';
import { HealthPanel } from './HealthPanel.tsx';
import { ProxyPanel } from './ProxyPanel.tsx';
import { Field } from './settings-field.tsx';
import { useSaveTemplate } from './use-save-template.ts';

function BrowserPanel({ template }: { readonly template: Template }) {
  const { save, saving } = useSaveTemplate(template);
  const channelId = useId();
  const headlessId = useId();
  const windowsId = useId();
  return (
    <Panel title="Browser" description="Every session of this template runs in this one browser.">
      <div className="flex flex-col gap-5">
        <Field label="Channel" htmlFor={channelId} hint="Changing it restarts the browser.">
          <SimpleSelect
            id={channelId}
            size="sm"
            className="w-48"
            value={template.channel}
            disabled={saving}
            options={(['chromium', 'chrome', 'edge'] as const).map((c) => ({
              value: c,
              label: CHANNEL_LABEL[c],
            }))}
            onValueChange={(value) => {
              const channel = Channel.safeParse(value);
              if (!channel.success || channel.data === template.channel) return;
              void save(
                { channel: channel.data, confirm_identity_change: true },
                'Channel changed',
                identityChangeConfirm('channel'),
              );
            }}
          />
        </Field>
        <Field label="Run without a window" htmlFor={headlessId}>
          <div className="flex items-center gap-3 sm:pt-1.5">
            <Switch
              id={headlessId}
              checked={template.headless}
              disabled={saving}
              onCheckedChange={(headless: boolean) =>
                void save({ headless }, headless ? 'Now headless' : 'Now headed')
              }
            />
            <span className="text-base">
              {template.headless ? 'Headless' : 'Headed (a window on the BrowserHive machine)'}
            </span>
          </div>
          {template.headless ? (
            <Callout tone="warn">
              Sites challenge headless browsers more often, and you can’t sign in again in a window.
            </Callout>
          ) : null}
        </Field>
        <Field
          label="Agent windows"
          htmlFor={windowsId}
          hint="How a session’s window opens on a headed browser. Windows never take focus."
        >
          <SimpleSelect
            id={windowsId}
            size="sm"
            className="w-48"
            value={template.agent_windows}
            disabled={saving}
            options={[
              { value: 'normal', label: 'Normal' },
              { value: 'minimized', label: 'Minimized' },
            ]}
            onValueChange={(value) => {
              const windows = AgentWindows.safeParse(value);
              if (windows.success)
                void save({ agent_windows: windows.data }, 'Agent windows changed');
            }}
          />
        </Field>
      </div>
    </Panel>
  );
}

/** The editable settings. */
export function BrowserSettings({ template }: { readonly template: Template }) {
  return (
    <>
      <BrowserPanel template={template} />
      <ProxyPanel template={template} />
      <HealthPanel template={template} />
    </>
  );
}

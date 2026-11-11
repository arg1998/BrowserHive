/** @module features/templates/detail/BrowserSettings — the editable part of the Settings tab (spec 13 §2.1–§2.2, §11.4): the browser (channel, headless with its warning, agent windows), the network (the pinned proxy; changing it or the channel restarts the browser and may sign the accounts out, so it is confirmed) and health checks (interval, pre-launch check) */

import { Channel } from '@browserhive/contracts/enums';
import type { Template } from '@browserhive/contracts/http';
import { AgentWindows } from '@browserhive/contracts/http';
import { type ReactNode, useId, useState } from 'react';
import { Callout } from '@/components/shared/Callout.tsx';
import { Panel } from '@/components/shared/Section.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Label } from '@/components/ui/label.tsx';
import { SimpleSelect } from '@/components/ui/select.tsx';
import { Switch } from '@/components/ui/switch.tsx';
import { identityChangeConfirm } from '../confirm-copy.ts';
import { CHANNEL_LABEL } from '../model.ts';
import {
  HEALTH_INTERVALS,
  type ProxyDraft,
  policyWith,
  proxyDraftOf,
  proxyPatch,
  proxyProblem,
} from './settings-patch.ts';
import { useSaveTemplate } from './use-save-template.ts';

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  readonly label: string;
  readonly htmlFor?: string;
  readonly hint?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="grid gap-1.5 sm:grid-cols-[12rem_minmax(0,1fr)] sm:items-start sm:gap-4">
      {htmlFor !== undefined ? (
        <Label htmlFor={htmlFor} className="sm:pt-2">
          {label}
        </Label>
      ) : (
        <span className="text-sm font-medium sm:pt-2">{label}</span>
      )}
      <div className="flex min-w-0 flex-col gap-1.5">
        {children}
        {hint !== undefined ? <p className="text-sm text-muted-foreground">{hint}</p> : null}
      </div>
    </div>
  );
}

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

function ProxyPanel({ template }: { readonly template: Template }) {
  const { save, saving } = useSaveTemplate(template);
  const [draft, setDraft] = useState<ProxyDraft | null>(null);
  const ids = { server: useId(), username: useId(), env: useId(), label: useId() };
  const proxy = template.proxy;
  if (draft === null) {
    return (
      <Panel
        title="Network"
        description="Sites see every session of this template come from one address."
        actions={
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setDraft(proxyDraftOf(template))}
          >
            {proxy === null ? 'Set a proxy…' : 'Change proxy…'}
          </Button>
        }
      >
        {proxy === null ? (
          <p className="text-base text-muted-foreground">
            No proxy: the browser uses this machine’s network.
          </p>
        ) : (
          <dl className="grid gap-x-4 gap-y-2 text-base sm:grid-cols-[12rem_minmax(0,1fr)]">
            <dt className="text-sm text-muted-foreground">Proxy</dt>
            <dd className="font-mono text-sm [overflow-wrap:anywhere]">{proxy.server}</dd>
            <dt className="text-sm text-muted-foreground">Label</dt>
            <dd>{proxy.label}</dd>
            <dt className="text-sm text-muted-foreground">User name</dt>
            <dd className="font-mono text-sm">{proxy.username ?? '—'}</dd>
            <dt className="text-sm text-muted-foreground">Password variable</dt>
            <dd className="font-mono text-sm">{proxy.password_env ?? '—'}</dd>
          </dl>
        )}
      </Panel>
    );
  }
  const problem = proxyProblem(draft);
  const set = (patch: Partial<ProxyDraft>) => setDraft({ ...draft, ...patch });
  return (
    <Panel
      title="Network"
      description="Changing the proxy restarts the browser. Sites may sign you out."
    >
      <div className="flex flex-col gap-4">
        <Field
          label="Proxy"
          htmlFor={ids.server}
          hint={problem ?? 'For example http://proxy.example:8080.'}
        >
          <Input
            id={ids.server}
            size="sm"
            className="font-mono"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={problem !== null}
            value={draft.server}
            onChange={(e) => set({ server: e.target.value })}
          />
        </Field>
        <Field label="User name" htmlFor={ids.username}>
          <Input
            id={ids.username}
            size="sm"
            autoComplete="off"
            value={draft.username}
            onChange={(e) => set({ username: e.target.value })}
          />
        </Field>
        <Field
          label="Password variable"
          htmlFor={ids.env}
          hint="The name of an environment variable BrowserHive reads; never the password."
        >
          <Input
            id={ids.env}
            size="sm"
            className="font-mono"
            autoComplete="off"
            spellCheck={false}
            placeholder="PROXY_PASSWORD"
            value={draft.password_env}
            onChange={(e) => set({ password_env: e.target.value })}
          />
        </Field>
        <Field label="Label" htmlFor={ids.label}>
          <Input
            id={ids.label}
            size="sm"
            autoComplete="off"
            value={draft.label}
            onChange={(e) => set({ label: e.target.value })}
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => setDraft(null)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={problem !== null || saving}
            onClick={() =>
              void save(proxyPatch(draft), 'Proxy changed', identityChangeConfirm('proxy')).then(
                (ok) => {
                  if (ok) setDraft(null);
                },
              )
            }
          >
            Save proxy
          </Button>
        </div>
      </div>
    </Panel>
  );
}

function HealthPanel({ template }: { readonly template: Template }) {
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

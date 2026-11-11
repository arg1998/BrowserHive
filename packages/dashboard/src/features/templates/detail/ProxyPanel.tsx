/** @module features/templates/detail/ProxyPanel — the Network panel of the Settings tab (spec 13 §2.2): the pinned proxy read-only, or its editor (address, user name, the NAME of the password variable, label); saving restarts the browser and may sign the accounts out, so it is confirmed */
import type { Template } from '@browserhive/contracts/http';
import { useId, useState } from 'react';
import { Panel } from '@/components/shared/Section.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { identityChangeConfirm } from '../confirm-copy.ts';
import { Field } from './settings-field.tsx';
import { type ProxyDraft, proxyDraftOf, proxyPatch, proxyProblem } from './settings-patch.ts';
import { useSaveTemplate } from './use-save-template.ts';

/** Network panel. */
export function ProxyPanel({ template }: { readonly template: Template }) {
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
        <Field label="Proxy" htmlFor={ids.server} hint={problem ?? 'Like http://10.0.0.5:3128.'}>
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

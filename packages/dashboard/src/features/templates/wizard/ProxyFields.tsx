/** @module features/templates/wizard/ProxyFields — the pinned proxy of step 3 (spec 13 §2.2): address (no user name or password in it), a label, the user name, and the NAME of the environment variable on the BrowserHive machine that holds the password (never the password) */
import { useId } from 'react';
import { Input } from '@/components/ui/input.tsx';
import { Field } from '../fields.tsx';
import type { TemplateDraft } from './draft.ts';

/** Proxy fields. */
export function ProxyFields({
  proxy,
  errors,
  onProxy,
}: {
  readonly proxy: TemplateDraft['proxy'];
  readonly errors: Readonly<Record<string, string>>;
  readonly onProxy: (patch: Partial<TemplateDraft['proxy']>) => void;
}) {
  const ids = { server: useId(), user: useId(), env: useId(), label: useId() };
  const setProxy = onProxy;
  return (
    <div className="grid max-w-3xl grid-cols-1 gap-5 rounded-lg border bg-surface-inset p-4 md:grid-cols-2">
      <Field
        label="Proxy address"
        htmlFor={ids.server}
        error={errors['proxy.server']}
        help="Like http://10.0.0.5:3128 or socks5://proxy.lan:1080."
      >
        <Input
          id={ids.server}
          value={proxy.server}
          placeholder="http://10.0.0.5:3128"
          spellCheck={false}
          autoComplete="off"
          className="font-mono"
          onChange={(event) => setProxy({ server: event.target.value })}
        />
      </Field>
      <Field label="Label" htmlFor={ids.label} optional help="How the dashboard names it.">
        <Input
          id={ids.label}
          value={proxy.label}
          placeholder="Toronto residential"
          onChange={(event) => setProxy({ label: event.target.value })}
        />
      </Field>
      <Field label="User name" htmlFor={ids.user} optional>
        <Input
          id={ids.user}
          value={proxy.username}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setProxy({ username: event.target.value })}
        />
      </Field>
      <Field
        label="Password variable"
        htmlFor={ids.env}
        optional
        error={errors['proxy.passwordEnv']}
        help="The name of an environment variable on the BrowserHive machine. The password itself is never stored."
      >
        <Input
          id={ids.env}
          value={proxy.passwordEnv}
          placeholder="BH_PROXY_PASSWORD"
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
          onChange={(event) => setProxy({ passwordEnv: event.target.value.trim() })}
        />
      </Field>
    </div>
  );
}

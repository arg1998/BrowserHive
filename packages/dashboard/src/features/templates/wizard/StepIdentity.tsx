/** @module features/templates/wizard/StepIdentity — step 3 (spec 13 §7.1, §2.2): the browser channel (an uninstalled one says how to install it), stealth level, fingerprint, headless (warned), the agents' window state, an optional pinned proxy (server, user name, the NAME of the variable holding its password) and the language and time zone sites see, required with a proxy and pre-filled from the BrowserHive machine. Everything here is fixed for the template's life except the proxy and channel */
import type { Channel, StealthLevel } from '@browserhive/contracts/enums';
import type { SystemInfo } from '@browserhive/contracts/http';
import { useId } from 'react';
import { Callout } from '@/components/shared/Callout.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { SimpleSelect } from '@/components/ui/select.tsx';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group.tsx';
import { Field, SwitchRow } from '../fields.tsx';
import type { TemplateDraft } from './draft.ts';

const CHANNEL_LABEL: { readonly [C in Channel]: string } = {
  chromium: 'Chromium',
  chrome: 'Google Chrome',
  edge: 'Microsoft Edge',
};

const STEALTH: readonly { readonly value: StealthLevel; readonly label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'standard', label: 'Standard' },
  { value: 'max', label: 'Max' },
];

/** What the server would pick, for "default" labels. */
export interface IdentityDefaults {
  readonly channel: Channel;
  readonly stealth: StealthLevel;
  readonly fingerprint: boolean;
  /** Installed channels; `null` while unknown (nothing is marked missing then). */
  readonly installed: ReadonlySet<Channel> | null;
  /** The time zone of the BrowserHive machine. */
  readonly timeZone: string | null;
  /** The language of this browser (the closest the dashboard knows). */
  readonly locale: string;
}

/** Server defaults from `GET /system`. */
export function identityDefaults(
  system: SystemInfo | undefined,
  timeZone: string | null,
  locale: string,
): IdentityDefaults {
  const profile = system?.stealth.profile;
  return {
    channel: system?.browser?.default_channel ?? 'chromium',
    stealth: profile === 'off' || profile === 'max' ? profile : 'standard',
    fingerprint: system?.stealth.fingerprint ?? true,
    installed:
      system?.browser === undefined
        ? null
        : new Set(system.browser.channels.filter((c) => c.installed).map((c) => c.channel)),
    timeZone,
    locale,
  };
}

/** Step 3. */
export function StepIdentity({
  draft,
  onDraft,
  errors,
  defaults,
}: {
  readonly draft: TemplateDraft;
  readonly onDraft: (update: (d: TemplateDraft) => TemplateDraft) => void;
  readonly errors: Readonly<Record<string, string>>;
  readonly defaults: IdentityDefaults;
}) {
  const ids = {
    channel: useId(),
    windows: useId(),
    server: useId(),
    user: useId(),
    env: useId(),
    label: useId(),
    locale: useId(),
    tz: useId(),
  };
  const channel = draft.channel ?? defaults.channel;
  const missing = defaults.installed !== null && !defaults.installed.has(channel);
  const stealth = draft.stealth ?? defaults.stealth;
  const setProxy = (patch: Partial<TemplateDraft['proxy']>) =>
    onDraft((d) => ({ ...d, proxy: { ...d.proxy, ...patch } }));
  const prefill = () =>
    onDraft((d) => ({
      ...d,
      locale: d.locale === '' ? defaults.locale : d.locale,
      timezoneId: d.timezoneId === '' ? (defaults.timeZone ?? '') : d.timezoneId,
    }));
  return (
    <div className="flex flex-col gap-6">
      <div className="grid max-w-3xl grid-cols-1 gap-5 md:grid-cols-2">
        <Field
          label="Browser"
          htmlFor={ids.channel}
          help="Kept for the template’s life: sites remember the browser an account uses."
        >
          <SimpleSelect
            id={ids.channel}
            value={channel}
            onValueChange={(value) =>
              onDraft((d) => ({
                ...d,
                channel: value === defaults.channel ? null : (value as Channel),
              }))
            }
            options={(Object.keys(CHANNEL_LABEL) as Channel[]).map((c) => ({
              value: c,
              label: `${CHANNEL_LABEL[c]}${c === defaults.channel ? ' (default)' : ''}${
                defaults.installed !== null && !defaults.installed.has(c) ? ' · not installed' : ''
              }`,
            }))}
          />
        </Field>
        <Field
          label="Agent windows"
          htmlFor={ids.windows}
          help="How agents’ windows open on this machine’s screen. They never take focus either way."
        >
          <SimpleSelect
            id={ids.windows}
            value={draft.agentWindows}
            onValueChange={(value) =>
              onDraft((d) => ({
                ...d,
                agentWindows: value === 'minimized' ? 'minimized' : 'normal',
              }))
            }
            options={[
              { value: 'normal', label: 'Normal, in the background' },
              { value: 'minimized', label: 'Minimized' },
            ]}
          />
        </Field>
      </div>
      {missing ? (
        <Callout
          tone="warn"
          title={`${CHANNEL_LABEL[channel]} is not installed on the BrowserHive machine`}
        >
          Install it there with{' '}
          <code className="font-mono text-sm">
            browserhive init{channel === 'chrome' ? ' --installChrome' : ''}
          </code>
          , or pick another browser. The template keeps this browser for life.
        </Callout>
      ) : null}
      <div className="flex max-w-3xl flex-col gap-2">
        <span className="text-base font-medium" id={`${ids.channel}-stealth`}>
          Stealth
        </span>
        <ToggleGroup
          aria-labelledby={`${ids.channel}-stealth`}
          size="sm"
          spacing={0}
          value={[stealth]}
          onValueChange={(value: readonly string[]) => {
            const next = value[0] as StealthLevel | undefined;
            if (next !== undefined)
              onDraft((d) => ({ ...d, stealth: next === defaults.stealth ? null : next }));
          }}
          className="self-start"
        >
          {STEALTH.map((level) => (
            <ToggleGroupItem key={level.value} value={level.value}>
              {level.label}
              {level.value === defaults.stealth ? ' (default)' : ''}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <p className="text-sm text-muted-foreground">
          {stealth === 'off'
            ? 'Sites can tell the browser is automated. Some sign-ins, like Google’s, refuse it.'
            : stealth === 'max'
              ? 'Every countermeasure on, at some cost in speed.'
              : 'Hides the usual automation signals. Right for most sites.'}
        </p>
      </div>
      <div className="flex max-w-3xl flex-col gap-4">
        <SwitchRow
          label="Consistent fingerprint"
          description="Screen, fonts and hardware details stay the same for this template, so sites see one device."
          checked={draft.fingerprint ?? defaults.fingerprint}
          onChange={(on) =>
            onDraft((d) => ({ ...d, fingerprint: on === defaults.fingerprint ? null : on }))
          }
        />
        <SwitchRow
          label="Run without a window (headless)"
          description="For servers without a screen. Sites challenge headless browsers more often, and you can’t sign in by hand: seed the template from a saved sign-in instead."
          tone="warn"
          checked={draft.headless}
          onChange={(on) => onDraft((d) => ({ ...d, headless: on }))}
        />
        <SwitchRow
          label="Use a proxy"
          description="Every session of this template goes out through it. BrowserHive never falls back to this machine’s address."
          checked={draft.useProxy}
          onChange={(on) => onDraft((d) => ({ ...d, useProxy: on }))}
        />
      </div>
      {draft.useProxy ? (
        <div className="grid max-w-3xl grid-cols-1 gap-5 rounded-lg border bg-background/60 p-4 md:grid-cols-2 dark:bg-white/[0.02]">
          <Field
            label="Proxy address"
            htmlFor={ids.server}
            error={errors['proxy.server']}
            help="scheme://host:port"
          >
            <Input
              id={ids.server}
              value={draft.proxy.server}
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
              value={draft.proxy.label}
              placeholder="Toronto residential"
              onChange={(event) => setProxy({ label: event.target.value })}
            />
          </Field>
          <Field label="User name" htmlFor={ids.user} optional>
            <Input
              id={ids.user}
              value={draft.proxy.username}
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
              value={draft.proxy.passwordEnv}
              placeholder="BH_PROXY_PASSWORD"
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              onChange={(event) => setProxy({ passwordEnv: event.target.value.trim() })}
            />
          </Field>
        </div>
      ) : null}
      <div className="grid max-w-3xl grid-cols-1 gap-5 md:grid-cols-2">
        <Field
          label="Language"
          htmlFor={ids.locale}
          optional={!draft.useProxy}
          error={errors['locale']}
          help={draft.useProxy ? 'Match the proxy’s country.' : 'Empty: the BrowserHive machine’s.'}
        >
          <Input
            id={ids.locale}
            value={draft.locale}
            placeholder={defaults.locale}
            spellCheck={false}
            autoComplete="off"
            className="font-mono"
            onChange={(event) => onDraft((d) => ({ ...d, locale: event.target.value.trim() }))}
          />
        </Field>
        <Field
          label="Time zone"
          htmlFor={ids.tz}
          optional={!draft.useProxy}
          error={errors['timezoneId']}
          help={
            draft.useProxy ? 'Match the proxy’s location.' : 'Empty: the BrowserHive machine’s.'
          }
        >
          <Input
            id={ids.tz}
            value={draft.timezoneId}
            placeholder={defaults.timeZone ?? 'America/Toronto'}
            spellCheck={false}
            autoComplete="off"
            className="font-mono"
            onChange={(event) => onDraft((d) => ({ ...d, timezoneId: event.target.value.trim() }))}
          />
        </Field>
      </div>
      {draft.useProxy && (draft.locale === '' || draft.timezoneId === '') ? (
        <div className="-mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>
            Sites compare the language and time zone with the proxy’s location, so they are set
            explicitly.
          </span>
          <Button type="button" variant="outline" size="sm" onClick={prefill}>
            Use this machine’s
          </Button>
        </div>
      ) : null}
    </div>
  );
}

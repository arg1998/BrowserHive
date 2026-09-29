/** @module features/notifications/channels/wizard/StepCredentials — step 2: where to get the secret (per platform), the environment variable that holds it (a suggested name outside `BROWSERHIVE_*`, editable), its live set/missing state polled from the server (never the value), and the exact lines for the way BrowserHive is started (D-33) */
import { CHANNEL_KIND_SPECS, type SecretParamSpec } from '@browserhive/contracts/notifications';
import type { ReactNode } from 'react';
import { Callout } from '@/components/shared/Callout.tsx';
import { ICONS } from '@/lib/icons.ts';
import { docsUrl } from '@/lib/links.ts';
import { type ChannelDraft, CONNECT_SECRETS, modeSecrets } from '../model.ts';
import { type EnvState, EnvVarField, LaunchInstructions, SwitchField } from './fields.tsx';

const DISCORD_BOT_WHERE: ReactNode = (
  <div className="flex flex-col gap-3 text-sm">
    <ol className="flex list-decimal flex-col gap-2 pl-5">
      <li>
        Open{' '}
        <a
          className="text-link hover:underline"
          href="https://discord.com/developers/applications"
          target="_blank"
          rel="noreferrer"
        >
          discord.com/developers
        </a>{' '}
        → <span className="font-medium">New Application</span> (name it BrowserHive) →{' '}
        <span className="font-medium">Bot</span> tab →{' '}
        <span className="font-medium">Reset Token</span>. Discord shows the token once: put it in
        the variable below, never in this page.
      </li>
      <li>
        Make the bot private, in this order: <span className="font-medium">Installation</span> tab →
        Install Link → <span className="font-medium">None</span> → Save; only then{' '}
        <span className="font-medium">Bot</span> tab → turn{' '}
        <span className="font-medium">Public Bot</span> off → Save.
      </li>
      <li>
        Leave every <span className="font-medium">Privileged Gateway Intent</span> off: button
        presses arrive without them.
      </li>
    </ol>
    <details className="rounded-lg border bg-card px-3 py-2">
      <summary className="cursor-pointer rounded-sm font-medium focus-ring">
        Discord says “Private application cannot have a default authorization link”
      </summary>
      <p className="mt-2 text-muted-foreground">
        Public Bot was turned off while an install link was still set. Open the{' '}
        <span className="font-medium">Installation</span> tab, set the Install Link to{' '}
        <span className="font-medium">None</span>, Save, then turn Public Bot off again.{' '}
        <a
          className="text-link hover:underline"
          href={docsUrl('discordBotTroubleshooting')}
          target="_blank"
          rel="noreferrer"
        >
          More fixes
        </a>
      </p>
    </details>
    <p className="text-muted-foreground">
      The next step invites the bot with the least it needs and picks the channel for you.
    </p>
  </div>
);

const WHERE: Readonly<Record<string, ReactNode>> = {
  telegram: (
    <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm">
      <li>
        In Telegram, open{' '}
        <a
          className="text-link hover:underline"
          href="https://t.me/BotFather"
          target="_blank"
          rel="noreferrer"
        >
          @BotFather
        </a>{' '}
        and send <code className="font-mono">/newbot</code>.
      </li>
      <li>Pick a display name and a username that ends in "bot".</li>
      <li>BotFather replies with a token. Put it in the variable below, not in this page.</li>
    </ol>
  ),
  discord: (
    <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm">
      <li>In your Discord server, open the settings of the channel that should receive alerts.</li>
      <li>
        Go to <span className="font-medium">Integrations → Webhooks → New Webhook</span>, name it
        BrowserHive.
      </li>
      <li>
        <span className="font-medium">Copy Webhook URL</span> and put it in the variable below. The
        URL is the password of the webhook: keep it out of chats and files you share.
      </li>
    </ol>
  ),
  ntfy: (
    <p className="text-sm">
      ntfy.sh needs no account and no token. A token is only needed when your server or topic is
      protected by a login.
    </p>
  ),
  webhook: (
    <p className="text-sm">
      A signing secret lets your receiver check that a request really came from BrowserHive: every
      request then carries <code className="font-mono">X-BrowserHive-Signature: sha256=…</code>, an
      HMAC of the body.
    </p>
  ),
};

const OPTIONAL_LABEL: Readonly<Record<string, string>> = {
  'ntfy.token': 'Use an access token',
  'webhook.secret': 'Sign requests with a secret',
};

/** Props. */
export interface StepCredentialsProps {
  readonly draft: ChannelDraft;
  readonly onSecretRef: (param: string, env: string | null) => void;
  readonly envState: (name: string) => EnvState;
  readonly checking: boolean;
  readonly errors: Readonly<Record<string, string>>;
  readonly readOnly: boolean;
}

/** Step 2. */
export function StepCredentials({
  draft,
  onSecretRef,
  envState,
  checking,
  errors,
  readOnly,
}: StepCredentialsProps) {
  if (draft.kind === null) return null;
  const spec = CHANNEL_KIND_SPECS[draft.kind];
  const params: readonly SecretParamSpec[] = modeSecrets(draft.kind, draft.mode).filter(
    (s) => !spec.eitherTargetOrSecret.includes(s.param) && !CONNECT_SECRETS.has(s.param),
  );
  const bot = draft.kind === 'discord' && draft.mode === 'bot';
  const names = params
    .map((p) => draft.secretRefs[p.param])
    .filter((n): n is string => n !== undefined && n !== '');
  const missing = names.filter((n) => envState(n) === false);
  const Shield = ICONS.secured;
  return (
    <div className="flex flex-col gap-6">
      <section
        aria-label="Where to get it"
        className="flex flex-col gap-2 rounded-xl border bg-muted/40 p-4 dark:bg-white/[0.02]"
      >
        <h3 className="text-base font-medium">Where to get it</h3>
        {bot ? DISCORD_BOT_WHERE : WHERE[draft.kind]}
      </section>

      <div className="flex flex-col gap-5">
        {params.map((p) => {
          const current = draft.secretRefs[p.param];
          const key = `${draft.kind}.${p.param}`;
          if (!p.required) {
            const on = current !== undefined;
            return (
              <div key={p.param} className="flex flex-col gap-3">
                <SwitchField
                  labelClassName="text-base"
                  checked={on}
                  disabled={readOnly}
                  onChange={(checked) => onSecretRef(p.param, checked ? p.suggestedEnv : null)}
                >
                  {OPTIONAL_LABEL[key] ?? `Use ${p.param}`}
                </SwitchField>
                {on ? (
                  <EnvVarField
                    label="Environment variable"
                    help={p.describe}
                    value={current}
                    disabled={readOnly}
                    onChange={(v) => onSecretRef(p.param, v)}
                    state={envState(current)}
                    checking={checking}
                    error={errors[`secret_refs.${p.param}`]}
                  />
                ) : null}
              </div>
            );
          }
          return (
            <EnvVarField
              key={p.param}
              label={`Environment variable for the ${p.param === 'webhook' ? 'webhook URL' : bot ? 'bot token' : p.param}`}
              help={`${p.describe} Use any name you like; names starting with BROWSERHIVE_ are reserved for BrowserHive's own settings.`}
              value={current ?? ''}
              disabled={readOnly}
              onChange={(v) => onSecretRef(p.param, v)}
              state={current === undefined ? null : envState(current)}
              checking={checking}
              error={errors[`secret_refs.${p.param}`]}
            />
          );
        })}
      </div>

      {names.length > 0 ? (
        <section aria-label="How to set it" className="flex flex-col gap-2">
          <h3 className="text-base font-medium">Set it where BrowserHive starts</h3>
          <LaunchInstructions names={names} />
        </section>
      ) : null}

      {missing.length > 0 ? (
        <Callout
          tone="warn"
          title={`${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set yet`}
        >
          Set {missing.length === 1 ? 'it' : 'them'} and restart BrowserHive. This page checks every
          few seconds, and your draft is kept in this browser, so you can pick up right here after
          the restart.
        </Callout>
      ) : null}

      <p className="flex gap-2 text-sm text-muted-foreground">
        <Shield aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        BrowserHive stores only the variable's name. The value stays in the environment, so a
        database backup never contains your token, and this page can only tell whether it is set.
      </p>
    </div>
  );
}

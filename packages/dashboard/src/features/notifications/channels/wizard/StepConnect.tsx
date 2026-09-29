/** @module features/notifications/channels/wizard/StepConnect — step 3: Telegram's one-tap connect (a `t.me/<bot>?start=<code>` link and QR code while the server waits two minutes for `/start`, then the captured chat and the person who connected it; a manual chat id as the fallback), Discord webhook (nothing more to connect), ntfy server and topic with the subscribe QR code, and the webhook URL (with the private-address note) */
import { NTFY_DEFAULT_SERVER } from '@browserhive/contracts/notifications';
import { useEffect, useId, useState } from 'react';
import { Callout } from '@/components/shared/Callout.tsx';
import { Button, buttonVariants } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { toAppError } from '@/lib/api/errors.ts';
import { ICONS } from '@/lib/icons.ts';
import { useServerNow } from '@/lib/server-now.ts';
import { cn } from '@/lib/utils.ts';
import { useStartTelegramConnect, useTelegramConnect } from '../api.ts';
import { type ChannelDraft, isPrivateUrl, isPublicNtfy, ntfyLinks, randomTopic } from '../model.ts';
import { QrCode } from '../QrCode.tsx';
import { type EnvState, EnvVarField, Field, SwitchField } from './fields.tsx';

/** Props shared by the platform parts. */
interface PartProps {
  readonly draft: ChannelDraft;
  readonly onTarget: (patch: Readonly<Record<string, string | null>>) => void;
  readonly onSecretRef: (param: string, env: string | null) => void;
  readonly envState: (name: string) => EnvState;
  readonly checking: boolean;
  readonly errors: Readonly<Record<string, string>>;
  readonly readOnly: boolean;
  /** Telegram: the person who connected the chat becomes the first allow-list entry. */
  readonly onConnectedUser: (user: { readonly id: string; readonly name: string } | null) => void;
}

function Countdown({ until }: { readonly until: number }) {
  const now = useServerNow(1000);
  const left = Math.max(0, Math.round((until - now) / 1000));
  return (
    <span className="tabular-nums">
      {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
    </span>
  );
}

function TelegramConnect({ draft, onTarget, envState, readOnly, onConnectedUser }: PartProps) {
  const tokenEnv = draft.secretRefs['token'] ?? '';
  const tokenSet = tokenEnv !== '' && envState(tokenEnv) === true;
  const start = useStartTelegramConnect();
  const [connectId, setConnectId] = useState<string | null>(null);
  const status = useTelegramConnect(connectId);
  const [manual, setManual] = useState(false);
  const chatId = useId();
  const threadId = useId();
  const session = start.data;
  const state = status.data;
  const Send = ICONS.platformTelegram;
  const Ok = ICONS.success;
  const Retry = ICONS.retry;
  const Group = ICONS.sessions;

  // Applied once per connection; onTarget/onConnectedUser are stable wizard setters.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the connection outcome only
  useEffect(() => {
    if (state?.status !== 'connected' || state.chat === null) return;
    onTarget({
      chat_id: state.chat.id,
      chat_title: state.chat.title,
      thread_id: state.chat.thread_id,
      bot_username: session?.bot_username ?? null,
    });
    onConnectedUser(state.user);
  }, [state?.status, state?.chat?.id]);

  const begin = () =>
    start.mutate(tokenEnv, {
      onSuccess: (result) => setConnectId(result.connect_id),
    });

  const connectedChat = draft.target['chat_id'];
  return (
    <div className="flex flex-col gap-5">
      {connectedChat !== undefined && connectedChat !== '' && state?.status !== 'waiting' ? (
        <div className="flex items-start gap-3 rounded-xl border border-success-border bg-success-bg/60 p-4">
          <Ok aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-success-text" />
          <div className="flex min-w-0 flex-col gap-0.5">
            <p className="font-medium">
              Connected to{' '}
              {draft.target['chat_title'] !== undefined && draft.target['chat_title'] !== ''
                ? draft.target['chat_title']
                : 'a chat'}
            </p>
            <p className="text-sm text-muted-foreground">
              Chat id <span className="font-mono">{connectedChat}</span>
              {draft.target['thread_id'] !== undefined && draft.target['thread_id'] !== '' ? (
                <>
                  {' '}
                  · topic <span className="font-mono">{draft.target['thread_id']}</span>
                </>
              ) : null}
              {state?.user !== null && state?.user !== undefined ? (
                <> · connected by {state.user.name}</>
              ) : null}
            </p>
          </div>
        </div>
      ) : null}

      {!readOnly ? (
        !tokenSet ? (
          <Callout tone="warn" title="Set the bot token first">
            The connect link needs the bot token in {tokenEnv === '' ? 'its variable' : tokenEnv}.
            Go back to Credentials, set it and restart BrowserHive.
          </Callout>
        ) : session === undefined || state?.status === 'expired' || state?.status === 'failed' ? (
          <div className="flex flex-col items-start gap-3 rounded-xl border p-4">
            <div className="flex flex-col gap-1">
              <h3 className="text-base font-medium">
                {connectedChat !== undefined && connectedChat !== ''
                  ? 'Connect a different chat'
                  : 'Connect a chat in one tap'}
              </h3>
              <p className="text-sm text-muted-foreground">
                BrowserHive makes a one-time link to your bot. Open it on your phone and press Start
                (or add the bot to a group); BrowserHive listens for two minutes and picks up the
                chat.
              </p>
            </div>
            {state?.status === 'expired' ? (
              <p className="text-sm text-warn-text">
                The link expired before anyone pressed Start.
              </p>
            ) : state?.status === 'failed' ? (
              <p className="text-sm text-danger-text">
                {state.error ?? 'Telegram refused the request.'}
              </p>
            ) : start.isError ? (
              <p className="text-sm text-danger-text">{toAppError(start.error).message}</p>
            ) : null}
            <Button type="button" onClick={begin} disabled={start.isPending}>
              {start.isPending ? (
                <Spinner />
              ) : state === undefined ? (
                <Send aria-hidden="true" />
              ) : (
                <Retry aria-hidden="true" />
              )}
              {state === undefined ? 'Create the connect link' : 'Try again'}
            </Button>
          </div>
        ) : state?.status === 'connected' ? null : (
          <div className="flex flex-col gap-4 rounded-xl border p-4 sm:flex-row sm:items-center">
            <QrCode
              value={session.link}
              label="QR code that opens the bot on your phone"
              className="size-40 shrink-0 self-center"
            />
            <div className="flex min-w-0 flex-col gap-3">
              <div className="flex flex-col gap-1">
                <h3 className="flex items-center gap-2 text-base font-medium">
                  <Spinner className="size-4" /> Waiting for /start from @{session.bot_username}
                </h3>
                <p className="text-sm text-muted-foreground">
                  Scan the code with your phone's camera, or open the link, then press Start. The
                  link works once and expires in <Countdown until={session.expires_at} />.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <a
                  href={session.link}
                  target="_blank"
                  rel="noreferrer"
                  className={buttonVariants({ size: 'sm' })}
                >
                  <Send aria-hidden="true" />
                  Open in Telegram
                </a>
                <a
                  href={session.group_link}
                  target="_blank"
                  rel="noreferrer"
                  className={buttonVariants({ variant: 'outline', size: 'sm' })}
                >
                  <Group aria-hidden="true" />
                  Add to a group instead
                </a>
              </div>
            </div>
          </div>
        )
      ) : null}

      <div className="flex flex-col gap-3">
        <button
          type="button"
          className="w-fit cursor-pointer rounded-sm text-sm text-link hover:underline focus-ring"
          aria-expanded={manual}
          onClick={() => setManual((v) => !v)}
        >
          {manual ? 'Hide the manual fields' : 'Enter the chat id yourself'}
        </button>
        {manual ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              label="Chat id"
              htmlFor={chatId}
              help="A person's id, or a group's (starts with -100)."
            >
              <Input
                id={chatId}
                className="font-mono"
                value={draft.target['chat_id'] ?? ''}
                disabled={readOnly}
                onChange={(e) => onTarget({ chat_id: e.target.value.trim() })}
              />
            </Field>
            <Field
              label="Topic id"
              htmlFor={threadId}
              optional
              help="For a forum topic inside a group."
            >
              <Input
                id={threadId}
                className="font-mono"
                value={draft.target['thread_id'] ?? ''}
                disabled={readOnly}
                onChange={(e) => onTarget({ thread_id: e.target.value.trim() || null })}
              />
            </Field>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function NtfyConnect({
  draft,
  onTarget,
  onSecretRef,
  envState,
  checking,
  errors,
  readOnly,
}: PartProps) {
  const serverId = useId();
  const topicId = useId();
  const server = draft.target['server'] ?? NTFY_DEFAULT_SERVER;
  const fromEnv = draft.secretRefs['topic'] !== undefined;
  const topic = draft.target['topic'] ?? '';
  const links = ntfyLinks(server, topic);
  const Refresh = ICONS.refresh;
  const External = ICONS.external;
  const publicServer = isPublicNtfy(server);
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field
          label="Server"
          htmlFor={serverId}
          help="ntfy.sh, or the address of your own ntfy server."
          error={errors['target.server']}
        >
          <Input
            id={serverId}
            value={server}
            disabled={readOnly}
            spellCheck={false}
            onChange={(e) => onTarget({ server: e.target.value.trim() })}
          />
        </Field>
        {!fromEnv ? (
          <Field
            label="Topic"
            htmlFor={topicId}
            help={
              publicServer
                ? 'On ntfy.sh anyone who knows the topic can read it: keep it long and random.'
                : 'The topic your phone subscribes to.'
            }
            error={errors['target.topic']}
          >
            <div className="flex gap-2">
              <Input
                id={topicId}
                className="font-mono"
                value={topic}
                disabled={readOnly}
                spellCheck={false}
                onChange={(e) => onTarget({ topic: e.target.value.trim() })}
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="Suggest a new random topic"
                disabled={readOnly}
                onClick={() => onTarget({ topic: randomTopic() })}
              >
                <Refresh aria-hidden="true" />
              </Button>
            </div>
          </Field>
        ) : (
          <EnvVarField
            label="Variable that holds the topic"
            help="The topic stays out of the database, like a token."
            value={draft.secretRefs['topic'] ?? ''}
            disabled={readOnly}
            onChange={(v) => onSecretRef('topic', v)}
            state={envState(draft.secretRefs['topic'] ?? '')}
            checking={checking}
            error={errors['secret_refs.topic']}
          />
        )}
      </div>
      <SwitchField
        labelClassName="text-base"
        checked={fromEnv}
        disabled={readOnly}
        onChange={(checked) => {
          if (checked) {
            onSecretRef('topic', 'BH_NTFY_TOPIC');
            onTarget({ topic: null });
          } else {
            onSecretRef('topic', null);
            onTarget({ topic: randomTopic() });
          }
        }}
      >
        Keep the topic in an environment variable
      </SwitchField>
      {!fromEnv && topic !== '' ? (
        <div className="flex flex-col gap-4 rounded-xl border p-4 sm:flex-row sm:items-center">
          <QrCode
            value={links.app}
            label="QR code that subscribes the ntfy app to this topic"
            className="size-36 shrink-0 self-center"
          />
          <div className="flex min-w-0 flex-col gap-2">
            <h3 className="text-base font-medium">Subscribe on your phone</h3>
            <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm text-muted-foreground">
              <li>Install the ntfy app (Android or iOS).</li>
              <li>
                Scan this code with the phone's camera, or tap + in the app and enter the topic.
              </li>
              <li>Send a test at the end of this setup to see it arrive.</li>
            </ol>
            <a
              href={links.web}
              target="_blank"
              rel="noreferrer"
              className="inline-flex w-fit items-center gap-1 font-mono text-sm break-all text-link hover:underline"
            >
              {links.web}
              <External aria-hidden="true" className="size-3.5 shrink-0" />
            </a>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function WebhookConnect({
  draft,
  onTarget,
  onSecretRef,
  envState,
  checking,
  errors,
  readOnly,
}: PartProps) {
  const urlId = useId();
  const fromEnv = draft.secretRefs['url'] !== undefined;
  const url = draft.target['url'] ?? '';
  return (
    <div className="flex flex-col gap-5">
      {!fromEnv ? (
        <Field
          label="URL"
          htmlFor={urlId}
          help="BrowserHive POSTs the notification as JSON here. Redirects to another host are not followed."
          error={errors['target.url']}
        >
          <Input
            id={urlId}
            className="font-mono"
            value={url}
            placeholder="https://hooks.example.net/browserhive"
            disabled={readOnly}
            spellCheck={false}
            onChange={(e) => onTarget({ url: e.target.value.trim() })}
          />
        </Field>
      ) : (
        <EnvVarField
          label="Variable that holds the URL"
          help="Use this when the URL itself contains a key."
          value={draft.secretRefs['url'] ?? ''}
          disabled={readOnly}
          onChange={(v) => onSecretRef('url', v)}
          state={envState(draft.secretRefs['url'] ?? '')}
          checking={checking}
          error={errors['secret_refs.url']}
        />
      )}
      <SwitchField
        labelClassName="text-base"
        checked={fromEnv}
        disabled={readOnly}
        onChange={(checked) => {
          if (checked) {
            onSecretRef('url', 'BH_WEBHOOK_URL');
            onTarget({ url: null });
          } else {
            onSecretRef('url', null);
            onTarget({ url: '' });
          }
        }}
      >
        The URL contains a key: keep it in an environment variable
      </SwitchField>
      {!fromEnv && isPrivateUrl(url) ? (
        <Callout tone="info" title="A private address">
          BrowserHive sends from inside your network, so it can reach addresses a website could not
          (Home Assistant or Gotify on your LAN). That is allowed; make sure this is the service you
          mean.
        </Callout>
      ) : null}
    </div>
  );
}

function DiscordConnect({ draft, envState }: PartProps) {
  const env = draft.secretRefs['webhook'] ?? '';
  const set = env !== '' && envState(env) === true;
  const Ok = ICONS.success;
  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-xl border p-4',
        set ? 'border-success-border bg-success-bg/60' : 'bg-muted/40 dark:bg-white/[0.02]',
      )}
    >
      <Ok
        aria-hidden="true"
        className={cn(
          'mt-0.5 size-5 shrink-0',
          set ? 'text-success-text' : 'text-muted-foreground',
        )}
      />
      <div className="flex flex-col gap-0.5">
        <p className="font-medium">Nothing else to connect</p>
        <p className="text-sm text-muted-foreground">
          The webhook URL decides the server and the channel.{' '}
          {set
            ? `${env} is set.`
            : `Set ${env === '' ? 'the variable' : env} and restart BrowserHive.`}
        </p>
      </div>
    </div>
  );
}

/** Step 3. */
export function StepConnect(props: PartProps) {
  switch (props.draft.kind) {
    case 'telegram':
      return <TelegramConnect {...props} />;
    case 'discord':
      return <DiscordConnect {...props} />;
    case 'ntfy':
      return <NtfyConnect {...props} />;
    case 'webhook':
      return <WebhookConnect {...props} />;
    default:
      return null;
  }
}

/** Props of {@link StepConnect}. */
export type StepConnectProps = PartProps;

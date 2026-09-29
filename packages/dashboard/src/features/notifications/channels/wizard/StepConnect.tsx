/** @module features/notifications/channels/wizard/StepConnect — step 3: Telegram's one-tap connect (a `t.me/<bot>?start=<code>` link and QR code while the server waits two minutes for `/start`, then the captured chat and the person who connected it; a manual chat id as the fallback), Discord webhook (nothing more to connect) or bot (invite link, server and channel pickers, the "This is me" account link), ntfy server and topic with the subscribe QR code and the optional reply topic (D-42), and the webhook URL (with the private-address note) */
import { NTFY_DEFAULT_SERVER } from '@browserhive/contracts/notifications';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { Callout } from '@/components/shared/Callout.tsx';
import { Button, buttonVariants } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { SimpleSelect } from '@/components/ui/select.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { toAppError } from '@/lib/api/errors.ts';
import { ICONS } from '@/lib/icons.ts';
import { useServerNow } from '@/lib/server-now.ts';
import { cn } from '@/lib/utils.ts';
import {
  useDiscordBot,
  useDiscordChannels,
  useDiscordConnect,
  useStartDiscordConnect,
  useStartTelegramConnect,
  useTelegramConnect,
} from '../api.ts';
import {
  type ChannelDraft,
  isPrivateUrl,
  isPublicNtfy,
  ntfyLinks,
  randomReplyTopic,
  randomTopic,
  USER_ID_RE,
} from '../model.ts';
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

/** An API error as one readable line (the platform's own detail when there is one). */
function describeError(error: unknown): string {
  const e = toAppError(error);
  const detail = e.details['detail'];
  return typeof detail === 'string' && detail !== '' ? `${e.title}: ${detail}` : e.message;
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
  const Group = ICONS.user;

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
              <p className="text-sm text-danger-text [overflow-wrap:anywhere]">
                {describeError(start.error)}
              </p>
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
            value={links.web}
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
      <NtfyReplyTopic
        draft={draft}
        onTarget={onTarget}
        onSecretRef={onSecretRef}
        envState={envState}
        checking={checking}
        errors={errors}
        readOnly={readOnly}
      />
    </div>
  );
}

/** The optional reply topic: act buttons post their token there (D-42). */
function NtfyReplyTopic({
  draft,
  onTarget,
  onSecretRef,
  envState,
  checking,
  errors,
  readOnly,
}: Omit<PartProps, 'onConnectedUser'>) {
  const topicId = useId();
  const literal = draft.target['reply_topic'];
  const fromEnv = draft.secretRefs['reply_topic'] !== undefined;
  const on = fromEnv || (literal !== undefined && literal !== '');
  const tokenOn = draft.secretRefs['reply_token'] !== undefined;
  const Refresh = ICONS.refresh;
  const Answer = ICONS.answer;
  const Shield = ICONS.secured;
  return (
    <section
      aria-labelledby={`${topicId}-title`}
      className="flex flex-col gap-4 rounded-xl border p-4"
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground dark:bg-white/[0.06]"
        >
          <Answer className="size-4.5" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h3 id={`${topicId}-title`} className="text-base font-medium">
            Answer from the notification{' '}
            <span className="text-xs font-normal text-muted-foreground">optional</span>
          </h3>
          <p className="text-sm text-muted-foreground">
            With a reply topic, Approve and Reject become buttons on the notification: tapping one
            makes the ntfy app post to this second topic, which BrowserHive listens to. Switch on
            “Answer from the chat” in the next step to use it.
          </p>
        </div>
      </div>
      <SwitchField
        labelClassName="text-sm"
        checked={on}
        disabled={readOnly}
        onChange={(checked) => {
          if (checked) onTarget({ reply_topic: randomReplyTopic() });
          else {
            onTarget({ reply_topic: null });
            onSecretRef('reply_topic', null);
            onSecretRef('reply_token', null);
          }
        }}
      >
        Use a reply topic
      </SwitchField>
      {on ? (
        <div className="flex flex-col gap-4">
          {!fromEnv ? (
            <Field
              label="Reply topic"
              htmlFor={topicId}
              help="A second topic on the same server. Never subscribe your phone to it."
              error={errors['target.reply_topic']}
            >
              <div className="flex max-w-lg gap-2">
                <Input
                  id={topicId}
                  className="font-mono"
                  value={literal ?? ''}
                  disabled={readOnly}
                  spellCheck={false}
                  onChange={(e) => onTarget({ reply_topic: e.target.value.trim() })}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label="Suggest a new random reply topic"
                  disabled={readOnly}
                  onClick={() => onTarget({ reply_topic: randomReplyTopic() })}
                >
                  <Refresh aria-hidden="true" />
                </Button>
              </div>
            </Field>
          ) : (
            <EnvVarField
              label="Variable that holds the reply topic"
              help="The reply topic stays out of the database, like a token."
              value={draft.secretRefs['reply_topic'] ?? ''}
              disabled={readOnly}
              onChange={(v) => onSecretRef('reply_topic', v)}
              state={envState(draft.secretRefs['reply_topic'] ?? '')}
              checking={checking}
              error={errors['secret_refs.reply_topic']}
            />
          )}
          <div className="flex flex-col gap-2">
            <SwitchField
              labelClassName="text-sm"
              checked={fromEnv}
              disabled={readOnly}
              onChange={(checked) => {
                if (checked) {
                  onSecretRef('reply_topic', 'BH_NTFY_REPLY_TOPIC');
                  onTarget({ reply_topic: null });
                } else {
                  onSecretRef('reply_topic', null);
                  onTarget({ reply_topic: randomReplyTopic() });
                }
              }}
            >
              Keep the reply topic in an environment variable
            </SwitchField>
            <SwitchField
              labelClassName="text-sm"
              checked={tokenOn}
              disabled={readOnly}
              onChange={(checked) =>
                onSecretRef('reply_token', checked ? 'BH_NTFY_REPLY_TOKEN' : null)
              }
            >
              Read it with its own access token (otherwise the channel's token is used)
            </SwitchField>
            {tokenOn ? (
              <EnvVarField
                label="Variable that holds the reply topic's token"
                help="Only BrowserHive reads the reply topic; this token needs read access to it."
                value={draft.secretRefs['reply_token'] ?? ''}
                disabled={readOnly}
                onChange={(v) => onSecretRef('reply_token', v)}
                state={envState(draft.secretRefs['reply_token'] ?? '')}
                checking={checking}
                error={errors['secret_refs.reply_token']}
              />
            ) : null}
          </div>
          <Callout tone="info" title="Who can press the buttons">
            ntfy has no accounts: whoever can read your notification topic can press its buttons, so
            keep that topic private. Someone who only learns the reply topic can post to it but
            cannot act: every button carries a one-time code BrowserHive checks.
            <span className="mt-2 flex gap-2">
              <Shield aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <span>
                On your own server, let everyone write to the reply topic but only BrowserHive read
                it:{' '}
                <code className="font-mono">ntfy access everyone {literal || 'bh-reply-…'} wo</code>
              </span>
            </span>
          </Callout>
        </div>
      ) : null}
    </section>
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

/** One numbered step of a setup sequence (done steps show a check). */
function SetupStep({
  n,
  title,
  done,
  children,
  aside,
}: {
  readonly n: number;
  readonly title: string;
  readonly done: boolean;
  readonly children: ReactNode;
  readonly aside?: ReactNode;
}) {
  const Check = ICONS.check;
  return (
    <li className="flex gap-3 rounded-xl border p-4">
      <span
        aria-hidden="true"
        className={cn(
          'flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold tabular-nums',
          done
            ? 'border-success-border bg-success-bg text-success-text'
            : 'border-border-strong text-muted-foreground',
        )}
      >
        {done ? <Check className="size-3.5" /> : n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h3 className="text-base font-medium">
            <span className="sr-only">
              Step {n}
              {done ? ' (done)' : ''}:{' '}
            </span>
            {title}
          </h3>
          {aside}
        </div>
        {children}
      </div>
    </li>
  );
}

/** Discord bot mode: invite the bot, pick the server and channel, link the operator's account (D-38). */
/** The fallback to the "This is me" press: your Discord user id, typed in. */
function ManualUserId({ onAdd }: { readonly onAdd: (id: string) => void }) {
  const inputId = useId();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const add = () => {
    const id = value.trim();
    if (!USER_ID_RE.test(id)) {
      setError('A Discord user id is a number, like 123456789012345678.');
      return;
    }
    onAdd(id);
    setAdded(id);
    setValue('');
    setError(null);
  };
  return (
    <details className="group/manual text-sm">
      <summary className="w-fit cursor-pointer text-muted-foreground hover:text-foreground">
        Add your user id by hand instead
      </summary>
      <div className="mt-2 flex flex-col gap-1.5">
        <label htmlFor={inputId} className="font-medium">
          Your Discord user id
        </label>
        <div className="flex max-w-md gap-2">
          <Input
            id={inputId}
            inputMode="numeric"
            className="font-mono"
            placeholder="123456789012345678"
            value={value}
            aria-invalid={error !== null ? true : undefined}
            onChange={(e) => {
              setValue(e.target.value.trim());
              setError(null);
              setAdded(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
          />
          <Button type="button" variant="outline" onClick={add}>
            Add
          </Button>
        </div>
        {error !== null ? (
          <p className="text-danger-text" role="alert">
            {error}
          </p>
        ) : added !== null ? (
          <p className="text-success-text" role="status">
            Added <span className="font-mono">{added}</span> to the allowed people.
          </p>
        ) : (
          <p className="text-muted-foreground">
            In Discord, turn on Developer Mode (User Settings → Advanced), then right-click your
            name and choose Copy User ID.
          </p>
        )}
      </div>
    </details>
  );
}

function DiscordBotConnect({ draft, onTarget, envState, readOnly, onConnectedUser }: PartProps) {
  const tokenEnv = draft.secretRefs['token'] ?? '';
  const tokenSet = tokenEnv !== '' && envState(tokenEnv) === true;
  const bot = useDiscordBot(tokenEnv, tokenSet);
  const guildId = draft.target['guild_id'] ?? null;
  const channels = useDiscordChannels(tokenEnv, guildId);
  const start = useStartDiscordConnect();
  const [connectId, setConnectId] = useState<string | null>(null);
  const status = useDiscordConnect(connectId);
  const [manual, setManual] = useState(false);
  const serverId = useId();
  const channelSelectId = useId();
  const manualId = useId();
  const state = status.data;
  const channelId = draft.target['channel_id'] ?? '';
  const Invite = ICONS.external;
  const Refresh = ICONS.refresh;
  const Ok = ICONS.success;
  const Link = ICONS.connect;
  const Bot = ICONS.platformDiscord;
  const linked =
    (state?.status === 'connected' && state.user !== null) ||
    (draft.rules.allow_list ?? []).length > 0;

  // Applied once per link: onConnectedUser is a stable wizard setter.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the link outcome only
  useEffect(() => {
    if (state?.status === 'connected' && state.user !== null) onConnectedUser(state.user);
  }, [state?.status, state?.user?.id]);

  // A bot in exactly one server: that server is the only choice.
  const onlyGuild = bot.data?.guilds.length === 1 ? bot.data.guilds[0] : undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: onTarget is a stable wizard setter
  useEffect(() => {
    if (onlyGuild !== undefined && guildId === null && !readOnly) {
      onTarget({ guild_id: onlyGuild.id, guild_name: onlyGuild.name });
    }
  }, [onlyGuild?.id, guildId, readOnly]);

  if (!tokenSet) {
    return (
      <Callout tone="warn" title="Set the bot token first">
        The setup talks to Discord with the bot token in{' '}
        {tokenEnv === '' ? 'its variable' : tokenEnv}. Go back to Credentials, set it and restart
        BrowserHive.
      </Callout>
    );
  }
  const guilds = bot.data?.guilds ?? [];
  const channelList = channels.data?.channels ?? [];
  const selectedChannel = channelList.find((c) => c.id === channelId);
  const channelName =
    selectedChannel !== undefined
      ? `#${selectedChannel.name}`
      : draft.target['channel_name'] !== undefined
        ? `#${draft.target['channel_name']}`
        : 'the channel';
  return (
    <div className="flex flex-col gap-5">
      <ol className="flex flex-col gap-3">
        <SetupStep
          n={1}
          title="Invite the bot to your server"
          done={guilds.length > 0}
          aside={
            bot.data !== undefined ? (
              <a
                href={bot.data.invite_url}
                target="_blank"
                rel="noreferrer"
                className={buttonVariants({ size: 'sm' })}
              >
                <Invite aria-hidden="true" />
                Invite the bot
              </a>
            ) : bot.isError ? (
              <Button type="button" size="sm" variant="outline" onClick={() => void bot.refetch()}>
                <Refresh aria-hidden="true" />
                Try again
              </Button>
            ) : null
          }
        >
          {bot.isPending ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner className="size-4" /> Asking Discord who the bot is…
            </p>
          ) : bot.isError ? (
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium text-danger-text">Discord did not accept the bot</p>
              <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
                {toAppError(bot.error).details['code'] === 'auth'
                  ? `Discord refused the token in ${tokenEnv}. Reset it in the Developer Portal (Bot → Reset Token), update the variable and restart BrowserHive.`
                  : describeError(bot.error)}
              </p>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-dc-primary text-white">
                  <Bot aria-hidden="true" className="size-4.5" />
                </span>
                <div className="flex min-w-0 flex-col">
                  <span className="truncate font-medium">{bot.data?.bot_username}</span>
                  <span className="text-sm text-muted-foreground">
                    {guilds.length === 0
                      ? 'Not in a server yet.'
                      : `In ${guilds.length} ${guilds.length === 1 ? 'server' : 'servers'}.`}
                  </span>
                </div>
              </div>
              <p className="text-sm text-muted-foreground">
                The link asks only for what BrowserHive uses: View Channels, Send Messages, Embed
                Links and Attach Files. It works for you as the application's owner even when the
                bot is private. Pick your server, press Authorize, then come back and refresh the
                server list.
              </p>
              <details className="group text-sm">
                <summary className="w-fit cursor-pointer rounded-sm text-link hover:underline focus-ring">
                  Invite it by hand instead
                </summary>
                <p className="mt-2 text-muted-foreground">
                  In the Developer Portal, open{' '}
                  <span className="font-medium">OAuth2 → URL Generator</span>, tick the scope{' '}
                  <span className="font-medium">bot</span> only (not applications.commands), choose
                  Guild Install if asked, tick View Channels, Send Messages, Embed Links and Attach
                  Files (Read Message History is optional; BrowserHive does not need it), open the
                  URL, pick your server and Authorize.
                </p>
              </details>
            </>
          )}
        </SetupStep>

        <SetupStep n={2} title="Choose the server and the channel" done={channelId !== ''}>
          {bot.data !== undefined ? (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field
                label="Server"
                htmlFor={serverId}
                help={
                  guilds.length === 0
                    ? 'The bot is in no server yet: invite it, then refresh.'
                    : 'The servers the bot has joined.'
                }
              >
                <div className="flex gap-2">
                  <SimpleSelect
                    id={serverId}
                    className="w-full flex-1"
                    value={guildId}
                    placeholder={guilds.length === 0 ? 'No server yet' : 'Choose a server'}
                    disabled={readOnly || guilds.length === 0}
                    options={guilds.map((g) => ({ value: g.id, label: g.name }))}
                    onValueChange={(id) =>
                      onTarget({
                        guild_id: id,
                        guild_name: guilds.find((g) => g.id === id)?.name ?? null,
                        channel_id: null,
                        channel_name: null,
                      })
                    }
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label="Refresh the servers"
                    disabled={bot.isFetching}
                    onClick={() => void bot.refetch()}
                  >
                    {bot.isFetching ? <Spinner /> : <Refresh aria-hidden="true" />}
                  </Button>
                </div>
              </Field>
              <Field
                label="Channel"
                htmlFor={channelSelectId}
                help="Text and announcement channels of the server."
                error={channels.isError ? describeError(channels.error) : undefined}
              >
                <SimpleSelect
                  id={channelSelectId}
                  className="w-full"
                  value={channelId === '' ? null : channelId}
                  placeholder={guildId === null ? 'Choose a server first' : 'Choose a channel'}
                  disabled={readOnly || guildId === null || channelList.length === 0}
                  options={channelList.map((c) => ({
                    value: c.id,
                    label: c.category === null ? `#${c.name}` : `#${c.name} · ${c.category}`,
                  }))}
                  onValueChange={(id) =>
                    onTarget({
                      channel_id: id,
                      channel_name: channelList.find((c) => c.id === id)?.name ?? null,
                    })
                  }
                />
              </Field>
            </div>
          ) : channelId !== '' ? (
            <p className="text-sm text-muted-foreground">
              Posting to <span className="font-medium text-foreground">{channelName}</span>
              {draft.target['guild_name'] !== undefined ? ` in ${draft.target['guild_name']}` : ''}.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              The pickers appear once Discord accepts the bot.
            </p>
          )}
          <div className="flex flex-col gap-3">
            <button
              type="button"
              className="w-fit cursor-pointer rounded-sm text-sm text-link hover:underline focus-ring"
              aria-expanded={manual}
              onClick={() => setManual((v) => !v)}
            >
              {manual ? 'Hide the manual field' : 'Enter the channel id yourself'}
            </button>
            {manual ? (
              <Field
                label="Channel id"
                htmlFor={manualId}
                help="Discord Settings → Advanced → Developer Mode on, then right-click the channel → Copy Channel ID."
                className="max-w-sm"
              >
                <Input
                  id={manualId}
                  className="font-mono"
                  inputMode="numeric"
                  value={channelId}
                  disabled={readOnly}
                  onChange={(e) => onTarget({ channel_id: e.target.value.trim() || null })}
                />
              </Field>
            ) : null}
          </div>
        </SetupStep>

        <SetupStep
          n={3}
          title="Link your Discord account"
          done={linked}
          aside={
            channelId !== '' && !readOnly && state?.status !== 'waiting' ? (
              <Button
                type="button"
                size="sm"
                variant={linked ? 'outline' : 'default'}
                disabled={start.isPending}
                onClick={() =>
                  start.mutate(
                    { tokenEnv, channelId },
                    { onSuccess: (result) => setConnectId(result.connect_id) },
                  )
                }
              >
                {start.isPending ? <Spinner /> : <Link aria-hidden="true" />}
                {state === undefined && !linked ? 'Send the link message' : 'Link another account'}
              </Button>
            ) : null
          }
        >
          <p className="text-sm text-muted-foreground">
            The bot posts a <span className="font-medium text-foreground">This is me</span> button
            in {channelName}. Press it within two minutes: your account becomes the first person
            allowed to answer from Discord. The message is removed afterwards.
          </p>
          {state?.status === 'waiting' ? (
            <p className="flex items-center gap-2 text-sm">
              <Spinner className="size-4" /> Waiting for your press in {channelName} ·{' '}
              <Countdown until={state.expires_at} />
            </p>
          ) : state?.status === 'connected' && state.user !== null ? (
            <p className="flex items-center gap-2 text-sm text-success-text">
              <Ok aria-hidden="true" className="size-4" />
              <span>
                Connected as <span className="font-medium">{state.user.name}</span>
                <span className="text-muted-foreground"> · first of the allowed people</span>
              </span>
            </p>
          ) : state?.status === 'expired' ? (
            <p className="text-sm text-warn-text">Nobody pressed the button in time.</p>
          ) : state?.status === 'failed' ? (
            <p className="text-sm text-danger-text [overflow-wrap:anywhere]">
              {state.error ?? 'Discord refused the request.'}
            </p>
          ) : start.isError ? (
            <p className="text-sm text-danger-text [overflow-wrap:anywhere]">
              {describeError(start.error)}
            </p>
          ) : channelId === '' ? (
            <p className="text-sm text-muted-foreground">Choose the channel first.</p>
          ) : null}
          {!readOnly ? <ManualUserId onAdd={(id) => onConnectedUser({ id, name: '' })} /> : null}
        </SetupStep>
      </ol>
    </div>
  );
}

/** Step 3. */
export function StepConnect(props: PartProps) {
  switch (props.draft.kind) {
    case 'telegram':
      return <TelegramConnect {...props} />;
    case 'discord':
      return props.draft.mode === 'bot' ? (
        <DiscordBotConnect {...props} />
      ) : (
        <DiscordConnect {...props} />
      );
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

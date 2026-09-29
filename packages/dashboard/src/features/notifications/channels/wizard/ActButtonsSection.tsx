/** @module features/notifications/channels/wizard/ActButtonsSection — "Answer from the chat" in the rules step (D-41): the act-button switch (off by default; disabled with the reason where the setup cannot receive presses), and for Telegram and Discord the allow-list editor (the person who connected the chat first, more numeric ids addable and removable); ntfy and the webhook explain who can answer instead */
import type { ChannelConnection } from '@browserhive/contracts/http';
import {
  hasPresserIdentity,
  type NotificationChannelRules,
  supportsActButtons,
} from '@browserhive/contracts/notifications';
import { useId, useState } from 'react';
import { Callout } from '@/components/shared/Callout.tsx';
import { StatusDot } from '@/components/shared/StatusBadge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Switch } from '@/components/ui/switch.tsx';
import { ICONS } from '@/lib/icons.ts';
import { LISTENER_STATE } from '@/lib/status-registry.ts';
import { cn } from '@/lib/utils.ts';
import { type ChannelDraft, USER_ID_RE } from '../model.ts';

const PLATFORM_NAME: Readonly<Record<string, string>> = {
  telegram: 'Telegram',
  discord: 'Discord',
  ntfy: 'ntfy',
  webhook: 'your receiver',
};

/** Where the answer happens, for the description. */
const WHERE_ANSWERED: Readonly<Record<string, string>> = {
  telegram: 'right in Telegram',
  discord: 'right in Discord',
  ntfy: 'right from the notification',
  webhook: 'through your own receiver',
};

/** Why act buttons cannot be switched on for this setup, or `null`. */
export function actButtonsBlocker(draft: ChannelDraft): string | null {
  if (draft.kind === null) return null;
  const supported = supportsActButtons({
    kind: draft.kind,
    mode: draft.mode,
    target: draft.target,
    secretRefs: draft.secretRefs,
  });
  if (supported) return null;
  if (draft.kind === 'discord') {
    return 'A Discord webhook can only carry links. Switch this channel to bot mode to answer from Discord.';
  }
  if (draft.kind === 'ntfy') {
    return 'ntfy needs a reply topic for the buttons to post to. Add one in the Connect step.';
  }
  return 'This platform cannot receive button presses.';
}

function initials(name: string): string {
  const parts = name.replace(/^@/, '').split(/\s+/).filter(Boolean);
  const letters =
    parts.length > 1 ? `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}` : name.slice(0, 2);
  return letters.toUpperCase();
}

/** Props. */
export interface ActButtonsSectionProps {
  readonly draft: ChannelDraft;
  readonly onRules: (rules: NotificationChannelRules) => void;
  readonly errors: Readonly<Record<string, string>>;
  readonly readOnly: boolean;
  /** The saved channel's press listener, when editing. */
  readonly connection: ChannelConnection | null;
  /** Opens another wizard step (the Platform step for Discord's mode, Connect for ntfy). */
  readonly onStep?: ((step: 'platform' | 'connect') => void) | undefined;
}

/** The act-button settings. */
export function ActButtonsSection({
  draft,
  onRules,
  errors,
  readOnly,
  connection,
  onStep,
}: ActButtonsSectionProps) {
  const rules = draft.rules;
  const on = rules.act_buttons === true;
  const blocker = actButtonsBlocker(draft);
  const switchId = useId();
  const inputId = useId();
  const [candidate, setCandidate] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);
  const allow = rules.allow_list ?? [];
  const people = draft.people ?? {};
  const kind = draft.kind ?? 'webhook';
  const platform = PLATFORM_NAME[kind] ?? kind;
  const identity = hasPresserIdentity(kind);
  const Answer = ICONS.answer;
  const Users = ICONS.allowList;
  const Remove = ICONS.close;
  const Add = ICONS.plus;
  const Warn = ICONS.warn;
  const User = ICONS.user;

  const setAllow = (next: readonly string[]) =>
    onRules({ ...rules, allow_list: next.length === 0 ? undefined : [...next] });
  const add = () => {
    const id = candidate.trim();
    if (!USER_ID_RE.test(id)) {
      setInputError(`A ${platform} user id is a number, like 123456789.`);
      return;
    }
    if (allow.includes(id)) {
      setInputError('That id is already on the list.');
      return;
    }
    if (allow.length >= 32) {
      setInputError('The list holds 32 people at most.');
      return;
    }
    setAllow([...allow, id]);
    setCandidate('');
    setInputError(null);
  };

  return (
    <section
      aria-labelledby={`${switchId}-title`}
      className={cn(
        'flex flex-col overflow-hidden rounded-xl border transition-colors',
        on && blocker === null && 'border-accent-border',
      )}
    >
      <div
        className={cn(
          'flex items-start gap-4 p-4',
          on && blocker === null && 'bg-accent-bg/40 dark:bg-accent-bg/25',
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            'flex size-9 shrink-0 items-center justify-center rounded-lg',
            on && blocker === null
              ? 'bg-primary text-primary-foreground'
              : 'bg-muted text-muted-foreground dark:bg-white/[0.06]',
          )}
        >
          <Answer className="size-4.5" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <label
            id={`${switchId}-title`}
            htmlFor={switchId}
            className={cn(
              'text-base font-medium',
              blocker === null && !readOnly ? 'cursor-pointer' : 'cursor-not-allowed',
            )}
          >
            Answer from the chat
          </label>
          <p className="text-sm text-muted-foreground">
            {`Approve, Reject and Mark resolved work ${WHERE_ANSWERED[kind] ?? `in ${platform}`}; everything else still opens BrowserHive.`}
            {kind === 'webhook'
              ? ' Off by default.'
              : ` Each button works once, for 24 hours, and only while the request waits.${on ? '' : ' Off by default.'}`}
          </p>
          {blocker !== null ? (
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-warn-text">
              <Warn aria-hidden="true" className="size-4 shrink-0" />
              <span className="min-w-0">{blocker}</span>
              {onStep !== undefined && !readOnly && (kind === 'discord' || kind === 'ntfy') ? (
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto p-0"
                  onClick={() => onStep(kind === 'discord' ? 'platform' : 'connect')}
                >
                  {kind === 'discord' ? 'Choose bot mode' : 'Add a reply topic'}
                </Button>
              ) : null}
            </p>
          ) : null}
          {connection !== null && on ? (
            <p className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
              Listening for presses:
              <StatusDot entry={LISTENER_STATE[connection.state]} />
              {connection.detail !== null ? (
                <span className="min-w-0 truncate">{connection.detail}</span>
              ) : null}
            </p>
          ) : null}
        </div>
        <Switch
          id={switchId}
          checked={on}
          disabled={readOnly || (blocker !== null && !on)}
          onCheckedChange={(checked) =>
            onRules({ ...rules, act_buttons: checked ? true : undefined })
          }
          className="mt-1"
        />
      </div>
      {errors['rules.act_buttons'] !== undefined ? (
        <p className="border-t px-4 py-2 text-sm text-danger-text" role="alert">
          {errors['rules.act_buttons']}
        </p>
      ) : null}

      {on && blocker === null && identity ? (
        <div className="flex flex-col gap-3 border-t p-4">
          <div className="flex items-center gap-2">
            <Users aria-hidden="true" className="size-4 text-muted-foreground" />
            <h4 className="text-sm font-medium">Allowed people</h4>
            <span className="text-xs text-muted-foreground">
              {allow.length === 0
                ? 'nobody yet'
                : `${allow.length} ${allow.length === 1 ? 'person' : 'people'}`}
            </span>
          </div>
          {allow.length > 0 ? (
            <ul aria-label="Allowed people" className="flex flex-col divide-y rounded-lg border">
              {allow.map((id) => {
                const name = people[id];
                return (
                  <li key={id} className="flex items-center gap-3 px-3 py-2">
                    <span
                      aria-hidden="true"
                      className="flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-semibold text-secondary-foreground dark:bg-white/10"
                    >
                      {name !== undefined ? initials(name) : <User className="size-4" />}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      {name !== undefined ? (
                        <>
                          <span className="truncate text-sm font-medium">{name}</span>
                          <span className="truncate font-mono text-xs text-muted-foreground">
                            {id}
                          </span>
                        </>
                      ) : (
                        <>
                          <span className="truncate font-mono text-sm font-medium">{id}</span>
                          <span className="truncate text-xs text-muted-foreground">
                            {platform} user id
                          </span>
                        </>
                      )}
                    </span>
                    {name !== undefined ? (
                      <span className="hidden rounded-full bg-success-bg px-2 text-xs leading-5 font-medium text-success-text sm:inline">
                        connected in setup
                      </span>
                    ) : null}
                    {!readOnly ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove ${name ?? id} from the allowed people`}
                        onClick={() => setAllow(allow.filter((x) => x !== id))}
                      >
                        <Remove aria-hidden="true" />
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <Callout tone="warn" title="Nobody can answer yet">
              Presses from people who are not on this list are refused.{' '}
              {kind === 'telegram'
                ? 'Connect the chat in the Connect step to add yourself, or add an id below.'
                : 'Link your Discord account in the Connect step, or add an id below.'}
            </Callout>
          )}
          {!readOnly ? (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={inputId} className="text-sm font-medium">
                Add a {platform} user id
              </label>
              <div className="flex max-w-md gap-2">
                <Input
                  id={inputId}
                  inputMode="numeric"
                  className="font-mono"
                  placeholder="123456789"
                  value={candidate}
                  aria-invalid={inputError !== null ? true : undefined}
                  onChange={(e) => {
                    setCandidate(e.target.value.trim());
                    setInputError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      add();
                    }
                  }}
                />
                <Button type="button" variant="outline" onClick={add}>
                  <Add aria-hidden="true" />
                  Add
                </Button>
              </div>
              {inputError !== null || errors['rules.allow_list'] !== undefined ? (
                <p className="text-sm text-danger-text" role="alert">
                  {inputError ?? errors['rules.allow_list']}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {kind === 'telegram'
                    ? 'When someone not on the list presses a button, the bot tells them their id. Add it here to let them answer.'
                    : 'In Discord, turn on Developer Mode (User Settings → Advanced), then right-click a member and choose Copy User ID.'}
                </p>
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      {on && blocker === null && kind === 'ntfy' ? (
        <div className="border-t p-4 text-sm text-muted-foreground">
          ntfy has no accounts, so there is no allow-list: whoever can read your notification topic
          can press its buttons. Keep that topic private (a long random name, or a protected topic
          on your own server).
        </div>
      ) : null}
      {on && kind === 'webhook' ? (
        <div className="border-t p-4 text-sm text-muted-foreground">
          The Approve and Reject actions travel in the payload as they are. Your receiver answers
          through the BrowserHive API with its own token (for example{' '}
          <code className="font-mono">POST /api/v1/attention/&lt;id&gt;/resolve</code>).
        </div>
      ) : null}
    </section>
  );
}

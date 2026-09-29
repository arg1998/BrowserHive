/** @module features/notifications/channels/wizard/ChannelWizardPage — the add-channel wizard (`/notifications/channels/new`, draft kept in `localStorage` so it survives the restart a new variable needs) and the channel page (`/notifications/channels/$channelId`, the same steps prefilled; read-only with a "from startup" notice for startup channels): a step rail, the step, and Back / Continue / Save (spec 04 §12.11.1) */
import type { ChannelView } from '@browserhive/contracts/http';
import type {
  AvailableChannelKind,
  NotificationChannelRules,
} from '@browserhive/contracts/notifications';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Callout } from '@/components/shared/Callout.tsx';
import { ErrorState } from '@/components/shared/ErrorState.tsx';
import { PageHeader } from '@/components/shared/PageHeader.tsx';
import { StatusDot } from '@/components/shared/StatusBadge.tsx';
import { Button, buttonVariants } from '@/components/ui/button.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { isAppError, toAppError } from '@/lib/api/errors.ts';
import { ICONS } from '@/lib/icons.ts';
import { CHANNEL_STATUS } from '@/lib/status-registry.ts';
import { cn } from '@/lib/utils.ts';
import { NotificationsNav } from '../../NotificationsNav.tsx';
import {
  useChannel,
  useChannelActions,
  useChannelEnv,
  useChannels,
  useCreateChannel,
  useUpdateChannel,
} from '../api.ts';
import {
  type ChannelDraft,
  channelWhere,
  clearDraft,
  draftEnvNames,
  draftForKind,
  draftForMode,
  draftFromChannel,
  draftProblems,
  draftToInput,
  draftToPatch,
  duplicateDraft,
  EMPTY_DRAFT,
  readDraft,
  stepProblems,
  WIZARD_STEP_LABEL,
  WIZARD_STEPS,
  type WizardStep,
  writeDraft,
} from '../model.ts';
import { PlatformMark, platformOf } from '../platforms.tsx';
import type { WizardSearch } from '../search.ts';
import type { EnvState } from './fields.tsx';
import { StepConnect } from './StepConnect.tsx';
import { StepCredentials } from './StepCredentials.tsx';
import { StepPlatform } from './StepPlatform.tsx';
import { StepPreview } from './StepPreview.tsx';
import { StepRules } from './StepRules.tsx';

const STEP_HINT: { readonly [S in WizardStep]: string } = {
  platform: 'Pick where notifications should go.',
  credentials: 'Keep the secret in an environment variable; BrowserHive stores only its name.',
  connect: 'Tell BrowserHive exactly where to deliver.',
  rules: 'Name the channel and choose what it receives.',
  preview: 'See exactly what arrives, then save and send a test.',
};

/** The step rail (vertical on wide screens, a compact progress line on narrow ones). */
function StepRail({
  step,
  reachable,
  done,
  onStep,
}: {
  readonly step: WizardStep;
  readonly reachable: (s: WizardStep) => boolean;
  readonly done: (s: WizardStep) => boolean;
  readonly onStep: (s: WizardStep) => void;
}) {
  const Check = ICONS.check;
  const index = WIZARD_STEPS.indexOf(step);
  return (
    <nav aria-label="Setup steps" className="min-w-0">
      <p className="mb-3 text-sm text-muted-foreground lg:hidden">
        Step {index + 1} of {WIZARD_STEPS.length} ·{' '}
        <span className="text-foreground">{WIZARD_STEP_LABEL[step]}</span>
      </p>
      <div className="mb-4 flex gap-1 lg:hidden" aria-hidden="true">
        {WIZARD_STEPS.map((s, i) => (
          <span
            key={s}
            className={cn(
              'h-1 flex-1 rounded-full',
              i <= index ? 'bg-primary' : 'bg-border-strong',
            )}
          />
        ))}
      </div>
      <ol className="hidden flex-col gap-1 lg:flex">
        {WIZARD_STEPS.map((s, i) => {
          const current = s === step;
          const complete = done(s) && i < index;
          const enabled = reachable(s);
          return (
            <li key={s}>
              <button
                type="button"
                disabled={!enabled}
                aria-current={current ? 'step' : undefined}
                onClick={() => onStep(s)}
                className={cn(
                  'flex w-full cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors focus-ring disabled:cursor-default',
                  current ? 'bg-accent-bg/70 dark:bg-accent-bg' : enabled && 'hover:bg-accent',
                )}
              >
                <span
                  className={cn(
                    'flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold tabular-nums',
                    current && 'border-primary bg-primary text-primary-foreground',
                    complete && 'border-success-border bg-success-bg text-success-text',
                    !current && !complete && 'text-muted-foreground',
                  )}
                >
                  {complete ? <Check aria-hidden="true" className="size-3.5" /> : i + 1}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className={cn('text-sm font-medium', !enabled && 'text-muted-foreground')}>
                    {WIZARD_STEP_LABEL[s]}
                  </span>
                  {current ? (
                    <span className="text-xs text-muted-foreground">{STEP_HINT[s]}</span>
                  ) : null}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** Everything a wizard needs besides where the draft comes from. */
interface WizardProps {
  readonly draft: ChannelDraft;
  readonly setDraft: (update: (d: ChannelDraft) => ChannelDraft) => void;
  readonly step: WizardStep;
  readonly onStep: (step: WizardStep) => void;
  readonly taken: readonly string[];
  readonly channel: ChannelView | null;
  readonly readOnly: boolean;
  readonly saving: boolean;
  readonly saveError: unknown;
  readonly onSave: () => void;
  readonly savedId: string | null;
  readonly title: ReactNode;
  readonly headerActions?: ReactNode;
  readonly notice?: ReactNode;
}

function Wizard({
  draft,
  setDraft,
  step,
  onStep,
  taken,
  channel,
  readOnly,
  saving,
  saveError,
  onSave,
  savedId,
  title,
  headerActions,
  notice,
}: WizardProps) {
  const [attempted, setAttempted] = useState<ReadonlySet<WizardStep>>(new Set());
  const names = draftEnvNames(draft);
  const env = useChannelEnv(names, step === 'credentials' || step === 'connect');
  const envState = useCallback(
    (name: string): EnvState => env.data?.vars.find((v) => v.name === name)?.set ?? null,
    [env.data],
  );
  const problems = stepProblems(draft, step);
  const errors = useMemo(() => {
    if (!attempted.has(step)) return {};
    return Object.fromEntries(problems.map((p) => [p.field, p.message]));
  }, [attempted, step, problems]);
  const index = WIZARD_STEPS.indexOf(step);
  const next = WIZARD_STEPS[index + 1];
  const prev = WIZARD_STEPS[index - 1];
  const editing = channel !== null;
  const reachable = (s: WizardStep) => {
    if (editing || savedId !== null) return true;
    const i = WIZARD_STEPS.indexOf(s);
    return WIZARD_STEPS.slice(0, i).every((earlier) => stepProblems(draft, earlier).length === 0);
  };
  const done = (s: WizardStep) => stepProblems(draft, s).length === 0 && draft.kind !== null;
  const serverErrors =
    saveError !== null && saveError !== undefined && isAppError(saveError) ? saveError : null;
  const ArrowLeft = ICONS.arrowLeft;
  const ArrowRight = ICONS.arrowRight;
  const Save = ICONS.check;

  const goNext = () => {
    setAttempted((a) => new Set([...a, step]));
    if (problems.length > 0 || next === undefined) return;
    onStep(next);
  };

  const updateTarget = (patch: Readonly<Record<string, string | null>>) =>
    setDraft((d) => {
      const target: Record<string, string> = { ...d.target };
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) delete target[k];
        else target[k] = v;
      }
      return { ...d, target };
    });
  const updateSecret = (param: string, value: string | null) =>
    setDraft((d) => {
      const secretRefs: Record<string, string> = { ...d.secretRefs };
      if (value === null) delete secretRefs[param];
      else secretRefs[param] = value;
      return { ...d, secretRefs };
    });

  const body = (() => {
    switch (step) {
      case 'platform':
        return (
          <StepPlatform
            draft={draft}
            locked={editing || readOnly}
            onKind={(kind: AvailableChannelKind) => setDraft((d) => draftForKind(d, kind, taken))}
            onMode={(mode) => setDraft((d) => draftForMode(d, mode))}
          />
        );
      case 'credentials':
        return (
          <StepCredentials
            draft={draft}
            envState={envState}
            checking={env.isFetching}
            errors={errors}
            readOnly={readOnly}
            onSecretRef={updateSecret}
          />
        );
      case 'connect':
        return (
          <StepConnect
            draft={draft}
            envState={envState}
            checking={env.isFetching}
            errors={errors}
            readOnly={readOnly}
            onTarget={updateTarget}
            onSecretRef={updateSecret}
            onConnectedUser={(user) =>
              setDraft((d) =>
                user === null
                  ? d
                  : {
                      ...d,
                      rules: {
                        ...d.rules,
                        allow_list: [
                          user.id,
                          ...(d.rules.allow_list ?? []).filter((id) => id !== user.id),
                        ],
                      },
                      ...(user.name !== '' && { people: { ...d.people, [user.id]: user.name } }),
                    },
              )
            }
          />
        );
      case 'rules':
        return (
          <StepRules
            draft={draft}
            errors={errors}
            readOnly={readOnly}
            onName={(name) => setDraft((d) => ({ ...d, name }))}
            onRules={(rules: NotificationChannelRules) => setDraft((d) => ({ ...d, rules }))}
            connection={channel?.connection ?? null}
            onStep={onStep}
          />
        );
      case 'preview':
        return (
          <StepPreview
            draft={draft}
            channelId={savedId ?? channel?.channel_id ?? null}
            ready={channel?.ready ?? true}
            readOnly={readOnly}
          />
        );
    }
  })();

  const saveLabel = editing ? 'Save changes' : 'Save channel';
  const allProblems = draftProblems(draft);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={title}
        description={
          channel === null
            ? 'BrowserHive sends notifications through your own bot, webhook or topic.'
            : `${platformOf(channel.kind).label}${channel.kind === 'discord' && channel.mode === 'bot' ? ' bot' : ''} channel · ${channelWhere(channel)}`
        }
        learnMore="Channels deliver notifications to the platforms you choose. Secrets stay in environment variables; everything else is set here and kept in the database."
        learnMoreDocs={draft.kind === null ? 'notificationChannels' : platformOf(draft.kind).docs}
        actions={headerActions}
        tabs={<NotificationsNav />}
      />
      {notice}
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <StepRail step={step} reachable={reachable} done={done} onStep={onStep} />
        <section
          aria-label={WIZARD_STEP_LABEL[step]}
          className="flex min-w-0 flex-col rounded-xl border bg-card shadow-xs dark:shadow-none"
        >
          <div className="flex items-center gap-3 border-b px-5 py-4">
            {draft.kind !== null ? <PlatformMark kind={draft.kind} size="sm" /> : null}
            <h2 className="text-md font-semibold">{WIZARD_STEP_LABEL[step]}</h2>
            {draft.kind !== null && step !== 'platform' ? (
              <span className="ml-auto truncate text-sm text-muted-foreground">
                {platformOf(draft.kind).label}
                {draft.name !== '' ? ` · ${draft.name}` : ''}
              </span>
            ) : null}
          </div>
          <div className="p-5">{body}</div>
          {serverErrors !== null && step === 'preview' ? (
            <div className="px-5 pb-4">
              <Callout tone="danger" title={serverErrors.title}>
                {serverErrors.code === 'CHANNEL_NAME_TAKEN'
                  ? `Another channel is already called ${draft.name}. Go back to What to send and pick another name.`
                  : serverErrors.message !== serverErrors.title
                    ? serverErrors.message
                    : (serverErrors.hint ?? '')}
              </Callout>
            </div>
          ) : null}
          {step === 'preview' && savedId === null && !readOnly && allProblems.length > 0 ? (
            <div className="px-5 pb-4">
              <Callout tone="warn" title="Some settings need attention before saving">
                <ul className="list-disc pl-4">
                  {allProblems.map((p) => (
                    <li key={p.field}>{p.message}</li>
                  ))}
                </ul>
              </Callout>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-2 rounded-b-xl border-t bg-muted/40 px-5 py-3 dark:bg-white/[0.02]">
            {prev !== undefined ? (
              <Button type="button" variant="ghost" onClick={() => onStep(prev)}>
                <ArrowLeft aria-hidden="true" />
                Back
              </Button>
            ) : (
              <Link to="/notifications/channels" className={buttonVariants({ variant: 'ghost' })}>
                Cancel
              </Link>
            )}
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {next !== undefined ? (
                <Button type="button" onClick={goNext}>
                  Continue
                  <ArrowRight aria-hidden="true" />
                </Button>
              ) : readOnly ? null : savedId !== null ? (
                <Link
                  to="/notifications/channels"
                  className={buttonVariants({ variant: 'default' })}
                >
                  Done
                </Link>
              ) : (
                <Button type="button" disabled={saving || allProblems.length > 0} onClick={onSave}>
                  {saving ? <Spinner /> : <Save aria-hidden="true" />}
                  {saveLabel}
                </Button>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function useStepNavigation(fallback: WizardStep) {
  const search = useSearch({ strict: false }) as WizardSearch;
  const navigate = useNavigate();
  const step = search.step ?? fallback;
  const onStep = useCallback(
    (next: WizardStep) =>
      void navigate({
        to: '.',
        search: (prev: Record<string, unknown>) => ({ ...prev, step: next }),
      }),
    [navigate],
  );
  return { step, onStep, search };
}

/** `/notifications/channels/new`. */
export function NewChannelPage() {
  const { step, onStep, search } = useStepNavigation('platform');
  const channels = useChannels();
  const taken = useMemo(() => (channels.data?.data ?? []).map((c) => c.name), [channels.data]);
  const [draft, setDraftState] = useState<ChannelDraft>(() => readDraft() ?? EMPTY_DRAFT);
  const [savedId, setSavedId] = useState<string | null>(null);
  const create = useCreateChannel();
  const applied = useRef(false);

  const setDraft = useCallback((update: (d: ChannelDraft) => ChannelDraft) => {
    setDraftState((d) => {
      const next = update(d);
      writeDraft(next);
      return next;
    });
  }, []);

  // `?from=` (Duplicate) and `?kind=` prefill the draft once the channel list is known.
  useEffect(() => {
    if (applied.current || channels.data === undefined) return;
    applied.current = true;
    const source =
      search.from === undefined
        ? undefined
        : channels.data.data.find((c) => c.channel_id === search.from);
    if (source !== undefined) setDraft(() => duplicateDraft(source, taken));
    else if (search.kind !== undefined)
      setDraft((d) => draftForKind(d, search.kind ?? 'webhook', taken));
  }, [channels.data, search.from, search.kind, taken, setDraft]);

  const save = () =>
    create.mutate(draftToInput(draft), {
      onSuccess: (result) => {
        setSavedId(result.channel.channel_id);
        clearDraft();
      },
    });

  const Restart = ICONS.undo;
  const hasDraft = draft.kind !== null;
  return (
    <Wizard
      draft={draft}
      setDraft={setDraft}
      step={step}
      onStep={onStep}
      taken={taken}
      channel={null}
      readOnly={false}
      saving={create.isPending}
      saveError={create.error}
      onSave={save}
      savedId={savedId}
      title="Add a channel"
      headerActions={
        hasDraft && savedId === null ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              clearDraft();
              setDraftState(EMPTY_DRAFT);
              onStep('platform');
            }}
          >
            <Restart aria-hidden="true" />
            Start over
          </Button>
        ) : undefined
      }
      notice={
        savedId !== null ? (
          <Callout tone="success" title={`${draft.name} is saved`}>
            It receives notifications from now on. Send a test below to see one arrive.
          </Callout>
        ) : undefined
      }
    />
  );
}

/** `/notifications/channels/$channelId`. */
export function EditChannelPage() {
  const { channelId } = useParams({ strict: false }) as { readonly channelId: string };
  const { step, onStep } = useStepNavigation('rules');
  const query = useChannel(channelId);
  const channels = useChannels();
  const channel = query.data?.channel ?? null;
  const [draft, setDraftState] = useState<ChannelDraft | null>(null);
  const update = useUpdateChannel(channelId);
  const actions = useChannelActions();
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (channel !== null && draft === null) setDraftState(draftFromChannel(channel));
  }, [channel, draft]);

  const setDraft = useCallback((u: (d: ChannelDraft) => ChannelDraft) => {
    setSaved(false);
    setDraftState((d) => (d === null ? d : u(d)));
  }, []);

  if (query.isError) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Channel" tabs={<NotificationsNav />} />
        <ErrorState
          tier="page"
          error={toAppError(query.error)}
          onRetry={() => void query.refetch()}
          escape={{ label: 'Back to channels', to: '/notifications/channels' }}
        />
      </div>
    );
  }
  if (channel === null || draft === null) {
    return (
      <div className="flex flex-col gap-6" aria-busy="true">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-96 w-full rounded-xl" />
      </div>
    );
  }
  const readOnly = channel.source === 'startup';
  const taken = (channels.data?.data ?? [])
    .filter((c) => c.channel_id !== channelId)
    .map((c) => c.name);
  const Pause = ICONS.pause;
  const Play = ICONS.play;
  return (
    <Wizard
      draft={draft}
      setDraft={setDraft}
      step={step}
      onStep={onStep}
      taken={taken}
      channel={channel}
      readOnly={readOnly}
      saving={update.isPending}
      saveError={update.error}
      onSave={() => update.mutate(draftToPatch(draft), { onSuccess: () => setSaved(true) })}
      savedId={null}
      title={
        <span className="inline-flex items-center gap-3">
          <PlatformMark kind={channel.kind} size="sm" />
          {channel.name}
          <StatusDot entry={CHANNEL_STATUS[channel.status]} className="text-sm font-normal" />
        </span>
      }
      headerActions={
        channel.status === 'active' ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => actions.pause.mutate(channel.channel_id)}
          >
            <Pause aria-hidden="true" />
            Pause
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => actions.resume.mutate(channel.channel_id)}
          >
            <Play aria-hidden="true" />
            Resume
          </Button>
        )
      }
      notice={
        readOnly ? (
          <Callout tone="info" title="This channel comes from the command line">
            It was declared with <code className="font-mono">--notificationChannel</code> when
            BrowserHive started, so it is read-only here: change the flag and restart to edit it.
            You can still preview it, send a test and pause it.
          </Callout>
        ) : saved ? (
          <Callout tone="success" title="Changes saved">
            They apply to the next notification.
          </Callout>
        ) : undefined
      }
    />
  );
}

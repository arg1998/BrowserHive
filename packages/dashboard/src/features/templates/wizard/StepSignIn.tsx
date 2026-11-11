/** @module features/templates/wizard/StepSignIn — step 5 (spec 13 §7.1, §3.11): open the sign-in window on the BrowserHive machine (the remote-operator notice when that is not this device), confirm each site with **I'm signed in**, watch the window from here, Finish (unlisted sign-ins offered for removal) or Cancel (the template stays Setting up); every error state has its copy and action, and a reload resumes where it was */
import { useNavigate } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { Callout } from '@/components/shared/Callout.tsx';
import { ErrorState } from '@/components/shared/ErrorState.tsx';
import { SkeletonCard } from '@/components/shared/Skeletons.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { LivePane } from '@/features/sessions/live/LivePane.tsx';
import { type AppError, toAppError } from '@/lib/api/errors.ts';
import { ICONS } from '@/lib/icons.ts';
import { docsUrl } from '@/lib/links.ts';
import { useTemplateDetail, useTemplateMutations } from '../api.ts';
import { TEMPLATES_LIVE } from '../live.ts';
import { RemoteOperatorBanner, useRemoteHost } from '../RemoteOperatorBanner.tsx';
import { FinishDialog } from './FinishDialog.tsx';
import { SignInDone } from './SignInDone.tsx';
import { SignInProblemCallout } from './SignInProblemCallout.tsx';
import { SignInSites } from './SignInSites.tsx';
import { signInProblem } from './sign-in-model.ts';
import { useRecordingSession } from './use-recording.ts';

/** Step 5 for the template `templateId` (created by step 4, or continued from the list). */
export function StepSignIn({ templateId }: { readonly templateId: string }) {
  const navigate = useNavigate();
  const toast = useToast();
  const remote = useRemoteHost();
  const detail = useTemplateDetail(templateId, { poll: !TEMPLATES_LIVE });
  const recording = useRecordingSession(templateId);
  const m = useTemplateMutations(templateId);
  const [startError, setStartError] = useState<AppError | null>(null);
  const [confirmErrors, setConfirmErrors] = useState<Readonly<Record<string, string>>>({});
  const [finishOpen, setFinishOpen] = useState(false);
  const [watch, setWatch] = useState(remote !== null);
  const sawWindow = useRef(false);
  const Window = ICONS.toolTab;
  const Eye = ICONS.show;

  if (detail.isPending) return <SkeletonCard />;
  if (detail.isError || detail.data === undefined)
    return (
      <ErrorState
        tier="region"
        error={toAppError(detail.error)}
        onRetry={() => void detail.refetch()}
      />
    );

  const { template, host, sites } = detail.data;
  if (template.status === 'ready') return <SignInDone template={template} />;
  const session = recording.session;
  if (session !== null) sawWindow.current = true;
  const windowOpen = session !== null;
  const problem = signInProblem({
    error: startError,
    host,
    template,
    windowLost: sawWindow.current && recording.known && !windowOpen,
  });
  const machine = remote ?? 'this computer';

  const open = async () => {
    setStartError(null);
    // A failed browser needs an operator restart before it starts again (spec 13 §3.2).
    try {
      await m.startRecording.mutateAsync(undefined);
      await recording.refetch();
    } catch (error) {
      setStartError(toAppError(error));
      void detail.refetch();
    }
  };
  const confirmSite = async (siteId: string) => {
    setConfirmErrors(({ [siteId]: _drop, ...rest }) => rest);
    try {
      await m.confirm.mutateAsync(siteId);
    } catch (error) {
      const e = toAppError(error);
      const message =
        e.code === 'CONFLICT'
          ? `No new sign-in on ${siteId} yet. Finish signing in there, then press again.`
          : e.message;
      setConfirmErrors((prev) => ({ ...prev, [siteId]: message }));
    }
  };
  const finish = async (removeSignIns: readonly string[]) => {
    try {
      const result = await m.finish.mutateAsync(removeSignIns);
      setFinishOpen(false);
      const uncleared = result.removed_sign_ins.flatMap((r) => r.uncleared_origins);
      if (uncleared.length > 0)
        toast.warning({
          title: 'Some sign-ins may remain',
          description: `Site data could not be cleared for ${uncleared.join(', ')}.`,
        });
    } catch {
      // The mutation toasts the error; the dialog stays open.
    }
  };
  const cancel = async () => {
    if (windowOpen) await m.cancel.mutateAsync().catch(() => undefined);
    void navigate({ to: '/templates' });
  };

  return (
    <div className="flex flex-col gap-5">
      <RemoteOperatorBanner />
      {problem !== null ? (
        <SignInProblemCallout
          problem={problem}
          templateId={templateId}
          retrying={m.startRecording.isPending}
          onRetry={() => void open()}
        />
      ) : null}
      {windowOpen ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <p className="text-base font-medium">The sign-in window is open on {machine}</p>
              <p className="text-sm text-pretty text-muted-foreground">
                One tab per site. Sign in as you normally would, then press I’m signed in for each
                site. Saved passwords and password-manager extensions aren’t available there.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-pressed={watch}
              onClick={() => setWatch((on) => !on)}
            >
              <Eye aria-hidden="true" />
              {watch ? 'Hide the window' : 'Watch the window'}
            </Button>
          </div>
        </div>
      ) : problem === null ? (
        <div className="flex flex-col items-start gap-4 rounded-lg border border-dashed border-border-strong p-5">
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent-bg text-accent-text">
              <Window aria-hidden="true" className="size-4.5" />
            </span>
            <div className="flex min-w-0 flex-col gap-1">
              <p className="text-base font-medium">Sign in by hand, once</p>
              <p className="max-w-2xl text-sm text-pretty text-muted-foreground">
                A browser window opens on {machine} with a tab for each site. Agents never see what
                you type. Google and a few other sites refuse automated browsers;{' '}
                <a
                  href={docsUrl('templatesGoogle')}
                  target="_blank"
                  rel="noreferrer"
                  className="text-link underline decoration-link/40 underline-offset-2 hover:decoration-link"
                >
                  see what to do
                </a>
                .
              </p>
            </div>
          </div>
          <Button
            type="button"
            disabled={m.startRecording.isPending || !recording.known}
            onClick={() => void open()}
          >
            {m.startRecording.isPending ? <Spinner /> : <Window aria-hidden="true" />}
            {remote !== null ? `Open browser on ${remote}` : 'Open the sign-in window'}
          </Button>
        </div>
      ) : null}
      {/* The ticks sit beside the window's live view when there is room (spec 13 §3.11). */}
      <div className="@container min-w-0">
        <div
          className={
            watch && session !== null
              ? 'grid items-start gap-4 @3xl:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]'
              : undefined
          }
        >
          <SignInSites
            sites={sites}
            windowOpen={windowOpen}
            pending={m.confirm.isPending ? (m.confirm.variables ?? null) : null}
            errors={confirmErrors}
            onConfirm={(siteId) => void confirmSite(siteId)}
          />
          {watch && session !== null ? (
            <LivePane
              session={session}
              takeover={null}
              gateKnown
              vaultEnabled={false}
              armTakeover={false}
              onArmed={() => undefined}
              onClose={() => setWatch(false)}
              layout="stacked"
            />
          ) : null}
        </div>
      </div>
      {host.profile_secrets ? (
        <Callout tone="warn" title="Saved passwords or autofill data are in this browser">
          Agents could trigger autofill. Clear them from the template’s page once you finish.
        </Callout>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 border-t pt-4">
        <Button
          type="button"
          variant="ghost"
          disabled={m.cancel.isPending}
          onClick={() => void cancel()}
        >
          {windowOpen ? 'Cancel and close the window' : 'Finish later'}
        </Button>
        <Button
          type="button"
          className="ml-auto"
          disabled={m.finish.isPending}
          onClick={() => {
            void detail.refetch();
            setFinishOpen(true);
          }}
        >
          Finish
        </Button>
      </div>
      <FinishDialog
        open={finishOpen}
        onOpenChange={setFinishOpen}
        sites={sites}
        unlisted={detail.data.unlisted_domains}
        finishing={m.finish.isPending}
        onFinish={(remove) => void finish(remove)}
      />
    </div>
  );
}

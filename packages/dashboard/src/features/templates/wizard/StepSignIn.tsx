/** @module features/templates/wizard/StepSignIn — step 5 (spec 13 §7.1, §3.11): open the sign-in window on the machine running BrowserHive (the remote-operator notice when that is not this device), confirm each site with **I'm signed in**, watch the window from here, Finish (warned when a site is not signed in; unlisted sign-ins offered for removal) or close the window (the template stays Setting up); on a ready template, `again` signs in again to a signed-out site. Every error state has its copy and action, and a reload resumes where it was */
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { Callout } from '@/components/shared/Callout.tsx';
import { ErrorState } from '@/components/shared/ErrorState.tsx';
import { SkeletonCard } from '@/components/shared/Skeletons.tsx';
import { Button } from '@/components/ui/button.tsx';
import { toAppError } from '@/lib/api/errors.ts';
import { RemoteOperatorBanner, useRemoteHost } from '../RemoteOperatorBanner.tsx';
import { FinishDialog } from './FinishDialog.tsx';
import { SignInDone } from './SignInDone.tsx';
import { SignInProblemCallout } from './SignInProblemCallout.tsx';
import { SignInSites } from './SignInSites.tsx';
import { SignInStart } from './SignInStart.tsx';
import { SignInWindowHeader, SignInWindowLayout } from './SignInWindow.tsx';
import { useSignIn } from './use-sign-in.ts';

/** Step 5 for `templateId`; `again` = sign in again to a ready template. */
export function StepSignIn({
  templateId,
  again,
  onAgain,
}: {
  readonly templateId: string;
  readonly again: boolean;
  /** Switch `again` on or off (the URL keeps it). */
  readonly onAgain: (on: boolean) => void;
}) {
  const navigate = useNavigate();
  const remote = useRemoteHost();
  const s = useSignIn(templateId);
  const [finishOpen, setFinishOpen] = useState(false);
  const [watch, setWatch] = useState(remote !== null);

  if (s.detail.isPending) return <SkeletonCard />;
  if (s.detail.isError || s.detail.data === undefined)
    return (
      <ErrorState
        tier="region"
        error={toAppError(s.detail.error)}
        onRetry={() => void s.detail.refetch()}
      />
    );
  const { template, host, sites, unlisted_domains: unlisted } = s.detail.data;
  const windowOpen = s.session !== null;
  const ready = template.status === 'ready';
  if (ready && !again && !windowOpen)
    return (
      <SignInDone
        template={template}
        onSignInAgain={() => {
          onAgain(true);
          void s.open();
        }}
      />
    );

  const leave = async () => {
    if (!(await s.closeWindow())) return;
    if (ready) onAgain(false);
    else void navigate({ to: '/templates' });
  };

  return (
    <div className="flex flex-col gap-5">
      <RemoteOperatorBanner />
      {s.problem !== null ? (
        <SignInProblemCallout
          problem={s.problem}
          templateId={templateId}
          templateName={template.name}
          retrying={s.opening}
          onRetry={() => void s.open()}
        />
      ) : null}
      {windowOpen ? (
        <SignInWindowHeader remote={remote} watching={watch} onWatch={setWatch} />
      ) : s.problem === null ? (
        <SignInStart
          remote={remote}
          opening={s.opening}
          ready={s.known}
          onOpen={() => void s.open()}
        />
      ) : null}
      <SignInWindowLayout
        session={s.session}
        watching={watch}
        remote={remote}
        onStopWatching={() => setWatch(false)}
      >
        <SignInSites
          sites={sites}
          windowOpen={windowOpen}
          pending={s.confirmingSite}
          errors={s.confirmErrors}
          onConfirm={(siteId) => void s.confirmSite(siteId)}
        />
      </SignInWindowLayout>
      {host.profile_secrets ? (
        <Callout tone="warn" title="Saved passwords or autofill data are in this browser">
          Agents could trigger autofill. Clear them from the template’s page once you finish.
        </Callout>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 border-t pt-4">
        {ready ? (
          <Button
            type="button"
            className="ml-auto"
            disabled={s.closing}
            onClick={() => void leave()}
          >
            {windowOpen ? 'Done, close the window' : 'Done'}
          </Button>
        ) : (
          <>
            <Button type="button" variant="ghost" disabled={s.closing} onClick={() => void leave()}>
              {windowOpen ? 'Close the window, finish later' : 'Finish later'}
            </Button>
            <Button
              type="button"
              className="ml-auto"
              disabled={s.finishing}
              onClick={() => {
                void s.detail.refetch();
                setFinishOpen(true);
              }}
            >
              Finish
            </Button>
          </>
        )}
      </div>
      <FinishDialog
        open={finishOpen}
        onOpenChange={setFinishOpen}
        sites={sites}
        unlisted={unlisted}
        finishing={s.finishing}
        onFinish={(remove) =>
          void s.finish(remove).then((done) => {
            if (done) setFinishOpen(false);
          })
        }
      />
    </div>
  );
}

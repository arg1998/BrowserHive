/** @module features/templates/detail/TemplateBanners — the template page's notices (spec 13 §11.4): the browser failed (with its error and Restart), agents paused while a sign-in window is open or the operator types in the live view (**Let agents continue**, confirmed; focus moves to the site's card when it goes), sites not signed in on a ready template (**Re-login…**, not while a re-login runs), a missing or mismatched key, identity drift, unsandboxed, saved passwords or autofill in the profile (Clear), and unlisted sign-ins (Remove sign-in each) */
import type { TemplateDetailResponse } from '@browserhive/contracts/http';
import { useRef } from 'react';
import { useConfirm } from '@/app/providers/ConfirmProvider.tsx';
import { Callout } from '@/components/shared/Callout.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { useSystem } from '@/features/system/api.ts';
import { ICONS } from '@/lib/icons.ts';
import { docsUrl } from '@/lib/links.ts';
import { useTemplateMutations, useTemplatesOverview } from '../api.ts';
import { useTemplateHealth } from '../api-health.ts';
import { letAgentsContinueConfirm } from '../confirm-copy.ts';
import { keyProblemOf, templateDegradationText } from '../degradations.ts';
import { liveViewSession } from '../LiveViewSignIn.tsx';
import { needsSignIn } from '../model.ts';
import { reloginActive } from '../relogin-text.ts';
import { useTemplateActions } from '../use-template-actions.ts';
import { selectedTemplateTab, siteCardHeading, useFocusRescue } from './focus-rescue.ts';

/** Props. */
export interface TemplateBannersProps {
  readonly detail: TemplateDetailResponse;
  /** Opens Re-login… for a site (`''`: choose in the dialog). */
  readonly onRelogin: (site: string) => void;
}

/** Agents of the template wait while a sign-in window is open (D-60); the urgent override. */
function AgentsPausedBanner({ detail }: { readonly detail: TemplateDetailResponse }) {
  const health = useTemplateHealth(detail.template.template_id);
  const confirm = useConfirm();
  const ref = useRef<HTMLDivElement>(null);
  const site = detail.relogin?.state === 'open' ? detail.relogin.site_id : null;
  const live = liveViewSession(detail.relogin) !== null;
  // Let agents continue removes the banner: focus goes to the site's card, or the selected tab.
  useFocusRescue(ref, () => siteCardHeading(site) ?? selectedTemplateTab(), 'paused');
  const onContinue = async () => {
    if (!(await confirm(letAgentsContinueConfirm()))) return;
    health.continueAgents.mutate();
  };
  return (
    <div ref={ref}>
      <Callout
        tone="warn"
        title={
          site !== null
            ? `Agents are paused while you sign in to ${site}`
            : 'Agents are paused while you sign in'
        }
        action={
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={health.continueAgents.isPending}
            onClick={() => void onContinue()}
          >
            {health.continueAgents.isPending ? <Spinner /> : null}
            Let agents continue…
          </Button>
        }
      >
        {live
          ? 'Launches and tool calls of this template’s sessions wait up to 15 s each, then get a retryable error, while you type in the live view (until 2 minutes without input).'
          : 'Launches and tool calls of this template’s sessions wait up to 15 s each, then get a retryable error, until the sign-in window closes.'}
      </Callout>
    </div>
  );
}

function DocsLink({
  page,
  children,
}: {
  readonly page: Parameters<typeof docsUrl>[0];
  readonly children: string;
}) {
  return (
    <a
      href={docsUrl(page)}
      target="_blank"
      rel="noreferrer"
      className="text-link underline decoration-link/40 underline-offset-2 hover:decoration-link"
    >
      {children}
    </a>
  );
}

/** Notices, most urgent first; nothing when all is well. */
export function TemplateBanners({ detail, onRelogin }: TemplateBannersProps) {
  const { template, host } = detail;
  const mutations = useTemplateMutations(template.template_id);
  const actions = useTemplateActions(template);
  const removing = mutations.removeSignIn.isPending ? mutations.removeSignIn.variables : undefined;
  // Identity drift is on the list rows; key problems are `/system` degradations naming the template.
  const overview = useTemplatesOverview();
  const identityDrift = overview.data?.data.find(
    (row) => row.template_id === template.template_id,
  )?.identity_drift;
  const system = useSystem();
  const keyProblem = keyProblemOf(system.data?.degradations, template.template_id);
  const signedOut =
    template.status === 'ready'
      ? detail.sites.filter((s) => s.enabled && needsSignIn(s.health.state))
      : [];
  return (
    <>
      {host.agents_paused ? <AgentsPausedBanner detail={detail} /> : null}
      {signedOut.length > 0 ? (
        <Callout
          tone="warn"
          title={`${signedOut.length} ${signedOut.length === 1 ? 'site isn’t' : 'sites aren’t'} signed in`}
          action={
            // One re-login runs at a time: none to start while one is queued, open or filling.
            reloginActive(detail.relogin) ? undefined : (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  onRelogin(signedOut.length === 1 ? (signedOut[0]?.site_id ?? '') : '')
                }
              >
                <ICONS.signIn aria-hidden="true" />
                Re-login…
              </Button>
            )
          }
        >
          Agents get signed-out pages on {signedOut.map((s) => s.site_id).join(', ')}.
          {reloginActive(detail.relogin)
            ? ` A re-login of ${detail.relogin.site_id} is under way; it shows on its card.`
            : null}
        </Callout>
      ) : null}
      {keyProblem !== null ? (
        <Callout tone="danger" title="Versions can’t be read or written">
          {templateDegradationText(keyProblem, template.display_name)} The browser keeps running.{' '}
          <DocsLink page="templatesBackups">Backups and keys</DocsLink>
        </Callout>
      ) : null}
      {host.state === 'failed' ? (
        <Callout
          tone="danger"
          title="The browser could not start"
          action={
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void actions.host('restart')}
            >
              Restart browser
            </Button>
          }
        >
          {host.last_error ?? 'It failed several times in a row.'} Agents cannot launch this
          template until it starts.{' '}
          <DocsLink page="templatesDisplays">Displays and servers</DocsLink>
        </Callout>
      ) : null}
      {identityDrift !== undefined ? (
        <Callout tone="warn" title="The browser version changed">
          Recorded with Chrome {identityDrift.from}, now running {identityDrift.to}. Sites may
          notice the new version; launches continue.{' '}
          <DocsLink page="templatesIdentity">Identity</DocsLink>
        </Callout>
      ) : null}
      {host.sandboxed === false ? (
        <Callout tone="warn" title="The browser runs without Chromium’s sandbox">
          A compromised page could reach this machine as BrowserHive’s user.{' '}
          <DocsLink page="securitySandbox">The browser sandbox</DocsLink>
        </Callout>
      ) : null}
      {host.profile_secrets ? (
        <Callout
          tone="warn"
          title="Saved passwords or autofill data are in this template’s browser"
          action={
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={mutations.clearProfileSecrets.isPending}
              onClick={() => void actions.clearProfileSecrets()}
            >
              {mutations.clearProfileSecrets.isPending ? <Spinner /> : null}
              Clear saved passwords and autofill
            </Button>
          }
        >
          Agents can trigger autofill. Clearing stops the browser; its sessions close.
        </Callout>
      ) : null}
      {detail.unlisted_domains.length > 0 ? (
        <Callout tone="warn" title="Also signed in to sites that aren’t part of this template">
          <p>
            Agents can use these sign-ins too. Remove the ones they shouldn’t have.{' '}
            <DocsLink page="templatesUnlisted">Unlisted sign-ins</DocsLink>
          </p>
          <ul className="mt-2 flex flex-col gap-1.5">
            {detail.unlisted_domains.map((domain) => (
              <li key={domain} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-mono text-sm text-foreground">{domain}</span>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={removing !== undefined}
                  aria-label={`Remove sign-in to ${domain}`}
                  onClick={() => mutations.removeSignIn.mutate(domain)}
                >
                  {removing === domain ? <Spinner /> : null}
                  Remove sign-in
                </Button>
              </li>
            ))}
          </ul>
        </Callout>
      ) : null}
    </>
  );
}

/** @module features/templates/wizard/SignInDone — the end of the wizard: the template is ready (a warning when a site is not signed in, with **Sign in again**), each site's state as text, and, for developers, the call that launches a session from it */
import type { Template } from '@browserhive/contracts/http';
import { Link } from '@tanstack/react-router';
import { CopyButton } from '@/components/shared/CopyButton.tsx';
import { Button, buttonVariants } from '@/components/ui/button.tsx';
import { ICONS } from '@/lib/icons.ts';
import { SITE_HEALTH } from '@/lib/status-registry.ts';
import { cn } from '@/lib/utils.ts';
import { HealthIcon } from '../SiteChips.tsx';

/** Done. `onSignInAgain` reopens the window. */
export function SignInDone({
  template,
  onSignInAgain,
}: {
  readonly template: Template;
  readonly onSignInAgain: () => void;
}) {
  const out = template.sites.filter((s) => s.health.state !== 'signed_in');
  const warn = out.length > 0;
  const Icon = warn ? ICONS.warn : ICONS.success;
  const snippet = `launch_session({ "slug": "agent", "template": "${template.name}" })`;
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div className="flex items-start gap-4">
        <span
          className={cn(
            'flex size-10 shrink-0 items-center justify-center rounded-full',
            warn ? 'bg-warn-bg text-warn-text' : 'bg-success-bg text-success-text',
          )}
        >
          <Icon aria-hidden="true" className="size-5" />
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-md font-semibold">
            {warn
              ? `${template.display_name} is ready, but ${out.length === 1 ? '1 site isn’t' : `${out.length} sites aren’t`} signed in`
              : `${template.display_name} is ready`}
          </p>
          <p className="text-base text-pretty text-muted-foreground">
            {warn
              ? `Agents can launch sessions from it, but get signed-out pages on ${out.map((s) => s.site_id).join(', ')}.`
              : 'Agents can now launch sessions from it. Each session is its own window of this template’s browser, already signed in.'}
          </p>
        </div>
      </div>
      <ul aria-label="Sites" className="flex flex-col gap-1.5 sm:pl-14">
        {template.sites.map((site) => (
          <li key={site.site_id} className="flex items-center gap-2 text-base">
            <HealthIcon state={site.health.state} className="size-4" />
            <span className="font-mono">{site.site_id}</span>
            <span className="text-muted-foreground">
              {site.health.state === 'unknown'
                ? 'Not signed in'
                : SITE_HEALTH[site.health.state].label}
            </span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2 sm:pl-14">
        {warn ? (
          <Button type="button" size="sm" onClick={onSignInAgain}>
            <ICONS.signIn aria-hidden="true" />
            Sign in again
          </Button>
        ) : null}
        <Link
          to="/templates/$id"
          params={{ id: template.template_id }}
          className={buttonVariants({ size: 'sm', variant: warn ? 'outline' : 'default' })}
        >
          Open the template
        </Link>
        <Link to="/templates" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
          All templates
        </Link>
      </div>
      <details className="group sm:pl-14">
        <summary className="w-fit cursor-pointer rounded-sm text-sm text-muted-foreground focus-ring hover:text-foreground">
          For developers: launching a session from it
        </summary>
        <div className="mt-2 flex max-w-full items-center gap-1 rounded-lg border bg-muted/50 py-1.5 pr-1.5 pl-3">
          <code className="min-w-0 flex-1 overflow-x-auto font-mono text-sm whitespace-nowrap">
            {snippet}
          </code>
          <CopyButton value={snippet} label="Copy the call" visibility="always" />
        </div>
      </details>
    </div>
  );
}

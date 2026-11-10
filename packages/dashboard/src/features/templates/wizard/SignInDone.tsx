/** @module features/templates/wizard/SignInDone — the end of the wizard: the template is ready, how each site ended, and how an agent launches a session from it */
import type { Template } from '@browserhive/contracts/http';
import { Link } from '@tanstack/react-router';
import { CopyButton } from '@/components/shared/CopyButton.tsx';
import { buttonVariants } from '@/components/ui/button.tsx';
import { ICONS } from '@/lib/icons.ts';
import { SiteChip } from '../SiteChips.tsx';

/** Done. */
export function SignInDone({ template }: { readonly template: Template }) {
  const Ready = ICONS.success;
  const snippet = `launch_session({ "slug": "agent", "template": "${template.name}" })`;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start gap-4">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-success-bg text-success-text">
          <Ready aria-hidden="true" className="size-5" />
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-md font-semibold">{template.display_name} is ready</p>
          <p className="text-base text-pretty text-muted-foreground">
            Agents can now launch sessions from it. Each session is its own window of this
            template’s browser, already signed in.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5 sm:pl-14">
        {template.sites.map((site) => (
          <SiteChip key={site.site_id} site={site.site_id} state={site.health.state} />
        ))}
      </div>
      <div className="flex flex-col gap-1.5 sm:pl-14">
        <span className="section-label">From an agent</span>
        <div className="flex max-w-full items-center gap-1 rounded-lg border bg-muted/50 py-1.5 pr-1.5 pl-3 dark:bg-white/[0.03]">
          <code className="min-w-0 flex-1 overflow-x-auto font-mono text-sm whitespace-nowrap">
            {snippet}
          </code>
          <CopyButton value={snippet} label="Copy the call" visibility="always" />
        </div>
      </div>
      <div className="flex flex-wrap gap-2 sm:pl-14">
        <Link
          to="/templates/$id"
          params={{ id: template.template_id }}
          className={buttonVariants({ size: 'sm' })}
        >
          Open the template
        </Link>
        <Link to="/templates" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
          All templates
        </Link>
      </div>
    </div>
  );
}

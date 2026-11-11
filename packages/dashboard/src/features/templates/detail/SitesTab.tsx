/** @module features/templates/detail/SitesTab — the Sites tab (spec 13 §11.4): one card per sign-in (sites that share a login sit together, `SiteCard`); while the template is still being set up, one notice with **Continue sign-in** instead of per-card hints; `?site=` brings a card into view */
import type { TemplateDetailResponse } from '@browserhive/contracts/http';
import { Link } from '@tanstack/react-router';
import { Callout } from '@/components/shared/Callout.tsx';
import { buttonVariants } from '@/components/ui/button.tsx';
import { ICONS } from '@/lib/icons.ts';
import { signInGroups } from '../model.ts';
import { SiteCard } from './SiteCard.tsx';

/** Sites tab. */
export function SitesTab({
  detail,
  focusSite,
}: {
  readonly detail: TemplateDetailResponse;
  readonly focusSite: string | undefined;
}) {
  const { template } = detail;
  const groups = signInGroups(detail.sites);
  const last = detail.sites.length <= 1;
  const settingUp = template.status === 'recording';
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {settingUp ? (
        <Callout
          tone="warn"
          title="Not signed in yet"
          action={
            <Link
              to="/templates/new"
              search={{ step: 5, template: template.template_id }}
              className={buttonVariants({ size: 'sm' })}
            >
              <ICONS.signIn aria-hidden="true" />
              Continue sign-in
            </Link>
          }
        >
          Finish setting up: open the sign-in window, sign in to each site and confirm it. Agents
          can’t use the template until then.
        </Callout>
      ) : null}
      <div className="grid min-w-0 gap-4 xl:grid-cols-2">
        {groups.flatMap((group) =>
          group.sites.map((site) => (
            <SiteCard
              key={site.site_id}
              templateId={template.template_id}
              site={site}
              title={group.title}
              last={last}
              settingUp={settingUp}
              focused={focusSite === site.site_id}
            />
          )),
        )}
      </div>
    </div>
  );
}

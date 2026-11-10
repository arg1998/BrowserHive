/** @module features/site-packs/SitePacksPage — `/site-packs` before site packs ship (spec 13 §11.4, §17 T3a): what a pack will add to a template, and how templates treat every site until then (a generic site whose sign-in cookies BrowserHive learns) */
import { Link } from '@tanstack/react-router';
import { Stack } from '@/components/shared/layout.tsx';
import { PageHeader } from '@/components/shared/PageHeader.tsx';
import { buttonVariants } from '@/components/ui/button.tsx';
import { ICONS } from '@/lib/icons.ts';
import { docsUrl } from '@/lib/links.ts';

const POINTS = [
  {
    title: 'Every site is a generic site for now',
    body: 'A template signs in to any domain. When you press I’m signed in, BrowserHive learns the cookies that appeared, and later checks that they are still there.',
  },
  {
    title: 'Packs add what a site needs',
    body: 'A pack is signed data about one site: where its sign-in page is, how to tell you are signed in, which requests change your account, and the pacing it tolerates.',
  },
  {
    title: 'You approve every update',
    body: 'Packs are bundled with BrowserHive or downloaded from browserhive.ai. Nothing is applied until you review the change here.',
  },
];

/** Site packs, not available in this build. */
export function SitePacksPage() {
  const Package = ICONS.sitePacks;
  const External = ICONS.external;
  return (
    <Stack gap={4}>
      <PageHeader
        title="Site packs"
        description="Per-site knowledge that keeps templates signed in and well-behaved."
        learnMoreDocs="dashboardSitePacks"
      />
      <section
        aria-labelledby="packs-off-title"
        className="flex flex-col gap-6 rounded-xl border bg-card p-6 shadow-xs sm:p-8 dark:shadow-none"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-4">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground dark:bg-white/[0.06]">
            <Package aria-hidden="true" className="size-5" />
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <h2 id="packs-off-title" className="text-md font-semibold">
              Site packs aren’t available in this version
            </h2>
            <p className="max-w-2xl text-base text-pretty text-muted-foreground">
              Templates work without them. This page will list the packs your templates use, their
              versions and the updates waiting for your approval.
            </p>
          </div>
        </div>
        <ul className="grid gap-4 md:grid-cols-3 sm:pl-14">
          {POINTS.map((point) => (
            <li key={point.title} className="flex min-w-0 flex-col gap-0.5">
              <h3 className="text-base font-medium">{point.title}</h3>
              <p className="text-sm text-pretty text-muted-foreground">{point.body}</p>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2 sm:pl-14">
          <Link to="/templates" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            Go to Templates
          </Link>
          <a
            href={docsUrl('templates')}
            target="_blank"
            rel="noreferrer"
            className={buttonVariants({ variant: 'ghost', size: 'sm' })}
          >
            Read the templates guide
            <External aria-hidden="true" />
          </a>
        </div>
      </section>
    </Stack>
  );
}

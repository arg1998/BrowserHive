/** @module features/templates/list/TemplatesEmpty — `/templates` empty states (spec 13 §11.4): zero data explains what a template is in three steps with **New template**; zero results offers Clear filters */
import { Link } from '@tanstack/react-router';
import { EmptyState } from '@/components/shared/EmptyState.tsx';
import { buttonVariants } from '@/components/ui/button.tsx';
import { ICONS } from '@/lib/icons.ts';
import { docsUrl } from '@/lib/links.ts';

const STEPS = [
  {
    title: 'Name it and pick the sites',
    body: 'The name is what agents ask for. Add every site the account signs in to, like linkedin.com.',
  },
  {
    title: 'Sign in once',
    body: 'A browser window opens on the machine running BrowserHive. Sign in by hand, as you would anywhere.',
  },
  {
    title: 'Agents launch from it',
    body: (
      <>
        An agent calls <code className="font-mono text-sm">launch_session</code> with the template’s
        name and gets its own window, already signed in.
      </>
    ),
  },
];

/** Zero data: what a template is, three steps, New template. */
export function TemplatesIntro() {
  const Icon = ICONS.templates;
  const Plus = ICONS.plus;
  const External = ICONS.external;
  return (
    <section aria-labelledby="templates-intro-title" className="flex flex-col gap-6 p-6 sm:p-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-4">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent-bg text-accent-text">
          <Icon aria-hidden="true" className="size-5" />
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id="templates-intro-title" className="text-md font-semibold">
            Sign in once, let every agent use it
          </h2>
          <p className="max-w-2xl text-base text-pretty text-muted-foreground">
            A template is one signed-in browser identity: its sites, cookies, fingerprint and
            network stay fixed. Agents launch sessions from it without ever seeing a password, and
            their sessions can’t copy the sign-in out.
          </p>
        </div>
      </div>
      <ol aria-label="How it works" className="grid max-w-5xl gap-4 md:grid-cols-3 sm:pl-14">
        {STEPS.map((step, index) => (
          <li key={step.title} className="flex gap-3 md:flex-col md:gap-2">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium tabular-nums">
              {index + 1}
            </span>
            <div className="flex min-w-0 flex-col gap-0.5">
              <h3 className="text-base font-medium">{step.title}</h3>
              <p className="text-sm text-pretty text-muted-foreground">{step.body}</p>
            </div>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2 sm:pl-14">
        <Link to="/templates/new" className={buttonVariants({ size: 'sm' })}>
          <Plus aria-hidden="true" />
          New template
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
  );
}

/** Empty state for the current search. */
export function TemplatesEmpty({
  filtered,
  onClear,
}: {
  readonly filtered: boolean;
  readonly onClear: () => void;
}) {
  if (!filtered) return <TemplatesIntro />;
  return (
    <EmptyState
      kind="zero-results"
      title="No templates match these filters"
      description="Change the status, browser state or search to see more."
      onClear={onClear}
    />
  );
}

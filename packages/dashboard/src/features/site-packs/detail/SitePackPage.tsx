/** @module features/site-packs/detail/SitePackPage — `/site-packs/$id` (spec 13 §11.4): every section of the pack as readable text (sign-in, signed-in check, writes and the site's terms, guards, guarded controls, security checks, sessions and pacing, what the site expects, strategies, verified dates and sources), its provenance, sources, what the registry lists and its settings, a revoked version kept in force, every pending version (followed or not) with **Download & review** or its diff, the local-file diff with **Approve**, its versions and its history; live over the `site-packs` topic */

import { Link, useParams } from '@tanstack/react-router';
import { usePageCrumb } from '@/app/shell/page-crumb.tsx';
import { Callout } from '@/components/shared/Callout.tsx';
import { Chip } from '@/components/shared/Chip.tsx';
import { ErrorState } from '@/components/shared/ErrorState.tsx';
import { PageHeader } from '@/components/shared/PageHeader.tsx';
import { Plain } from '@/components/shared/Plain.tsx';
import { Section } from '@/components/shared/Section.tsx';
import { SkeletonCard } from '@/components/shared/Skeletons.tsx';
import { useTemplatesOverview } from '@/features/templates/api.ts';
import { toAppError } from '@/lib/api/errors.ts';
import { useRegistryStatus, useSitePack } from '../api.ts';
import { DecisionFocusScope, focusElement } from '../decision-focus.tsx';
import { HistoryTab } from '../HistoryTabs.tsx';
import { useSitePacksLive } from '../live.ts';
import { skippedText } from '../model.ts';
import { usedByText } from '../pack-columns.tsx';
import { DecisionCards, hasAvailable, pendingDecisions, RevealsNote } from '../UpdatesSection.tsx';
import { CheckSection, SignInSection, TermsSection } from './AccessSections.tsx';
import { BrowserSection, PacingSection, ProvenanceSection } from './LimitSections.tsx';
import { PackOverview } from './PackOverview.tsx';
import { ChallengesSection, ElementGuardsSection, GuardsSection } from './RuleSections.tsx';
import { StrategiesSection } from './StrategiesSection.tsx';

/** One pack. */
export function SitePackPage() {
  const params = useParams({ strict: false }) as { readonly id?: string };
  const id = params.id ?? '';
  const query = useSitePack(id);
  const status = useRegistryStatus();
  const templates = useTemplatesOverview();
  const nameOf = (templateId: string) =>
    templates.data?.data.find((t) => t.template_id === templateId)?.display_name ?? templateId;
  useSitePacksLive();
  usePageCrumb(query.data?.view.title ?? null);
  if (query.isPending) return <SkeletonCard />;
  if (query.isError) {
    const error = toAppError(query.error);
    return (
      <ErrorState
        tier="page"
        error={error}
        {...(error.status === 404 && { title: 'Site pack not found' })}
        onRetry={() => void query.refetch()}
        escape={{ label: 'Back to site packs', to: '/site-packs' }}
      />
    );
  }
  const detail = query.data;
  const { view, pack } = detail;
  // A pack's own page lists every pending version, followed or pinned or not.
  const decisions = pendingDecisions([view], { all: true });
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <PageHeader
        title={<Plain>{view.title}</Plain>}
        learnMore="Everything this pack tells BrowserHive about the site, as plain text. Addresses are shown as text, never as links."
        learnMoreDocs="sitePacks"
        badge={!view.enabled ? <Chip tone="muted">Turned off</Chip> : undefined}
        description={
          <span className="font-mono text-sm [overflow-wrap:anywhere]">
            {view.domains.join(', ')}
          </span>
        }
        meta={
          <span className="text-sm text-muted-foreground">
            {view.used_by.length === 0
              ? 'No template uses it yet'
              : `Used by ${usedByText(view)}: `}
            {view.used_by.map((t, i) => (
              <span key={t}>
                {i > 0 ? ', ' : ''}
                <Link
                  to="/templates/$id"
                  params={{ id: t }}
                  className="text-link underline decoration-link/40 underline-offset-2 hover:decoration-link"
                >
                  {nameOf(t)}
                </Link>
              </span>
            ))}
          </span>
        }
      />
      {view.skipped !== undefined ? (
        <Callout
          tone="warn"
          title={
            view.approved === null && view.offer === null
              ? 'Not in force: none of the rules below apply'
              : 'A version was skipped'
          }
        >
          <Plain>{skippedText(view.skipped)}</Plain>
        </Callout>
      ) : null}
      <DecisionFocusScope
        keys={decisions.map((d) => d.key)}
        fallback={() => focusElement(document.querySelector<HTMLElement>('h1'))}
      >
        {decisions.length > 0 ? (
          <div data-updates="" className="contents">
            <Section
              title="Waiting for your review"
              count={decisions.length}
              {...(view.pinned_version !== null && {
                description: `Pinned at v${view.pinned_version}: newer versions wait here until you unpin it or apply one.`,
              })}
              {...(view.pinned_version === null &&
                !view.follow.effective &&
                view.pending.length > 0 && {
                  description:
                    'Not followed: these versions are not listed under Updates available.',
                })}
            >
              {hasAvailable(decisions) ? <RevealsNote /> : null}
              <DecisionCards decisions={decisions} status={status} />
            </Section>
          </div>
        ) : null}
        <div className="grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="flex min-w-0 flex-col gap-4">
            {pack === null ? (
              <p className="rounded-xl border bg-card p-5 text-base text-muted-foreground">
                Only a local file that isn’t approved exists for this pack. Its content shows in the
                review above.
              </p>
            ) : (
              <>
                {pack.description !== undefined ? (
                  <p className="max-w-3xl text-base text-pretty">
                    <Plain>{pack.description}</Plain>
                  </p>
                ) : null}
                <SignInSection pack={pack} />
                <CheckSection pack={pack} />
                <TermsSection pack={pack} writeGuards={view.write_guards} />
                <GuardsSection pack={pack} />
                <ElementGuardsSection pack={pack} />
                <ChallengesSection pack={pack} />
                <PacingSection pack={pack} />
                <BrowserSection pack={pack} />
                <StrategiesSection pack={pack} />
                <ProvenanceSection pack={pack} />
              </>
            )}
          </div>
          <PackOverview detail={detail} />
        </div>
      </DecisionFocusScope>
      <Section title="History">
        <HistoryTab packId={view.pack_id} />
      </Section>
    </div>
  );
}

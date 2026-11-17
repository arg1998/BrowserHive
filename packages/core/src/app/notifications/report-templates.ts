/** @module app/notifications/report-templates — the "Templates" part of the daily and weekly digests (D-43, spec 13 §8.6): in the period, the sites that went signed out (distinct template and site), the re-logins (versions written with reason `relogin`) and the challenges (probes that met one); omitted when all are 0 or templates are off. */

import type { Block } from '@browserhive/contracts/notifications';
import type { Repositories } from '../../ports/persistence/unit-of-work.ts';
import { formatCount, text } from './message.ts';

/** What a digest says about templates in its window. */
export interface TemplateDigestFacts {
  /** Distinct template sites with at least one `signed_out` probe. */
  readonly signedOut: number;
  /** Versions written by a re-login. */
  readonly relogins: number;
  /** Probes that met a challenge. */
  readonly challenges: number;
}

/** Where the template facts come from. */
export type TemplateReportRepos = Pick<Repositories, 'templateProbes' | 'templateVersions'>;

/**
 * The template facts of `[since, until)`.
 *
 * @returns The counts (all 0 when nothing happened).
 */
export async function templateDigestFacts(
  repos: TemplateReportRepos,
  window: { readonly since: number; readonly until: number },
): Promise<TemplateDigestFacts> {
  const [probes, versions] = await Promise.all([
    repos.templateProbes.since(window.since, window.until),
    repos.templateVersions.listAll(),
  ]);
  const signedOut = new Set<string>();
  let challenges = 0;
  for (const probe of probes) {
    if (probe.outcome === 'signed_out') signedOut.add(`${probe.templateId}\u0000${probe.siteId}`);
    else if (probe.outcome === 'challenged') challenges += 1;
  }
  const relogins = versions.filter(
    (v) => v.reason === 'relogin' && v.createdAt >= window.since && v.createdAt < window.until,
  ).length;
  return { signedOut: signedOut.size, relogins, challenges };
}

/** True when the facts have something to say. */
export function hasTemplateNews(facts: TemplateDigestFacts | null | undefined): boolean {
  return (
    facts !== null &&
    facts !== undefined &&
    (facts.signedOut > 0 || facts.relogins > 0 || facts.challenges > 0)
  );
}

/**
 * The digest's "Templates" heading and fields (numbers and fixed labels only, so every content
 * level carries them); none when templates are off or nothing happened.
 */
export function templateDigestBlocks(facts: TemplateDigestFacts | null | undefined): Block[] {
  if (facts === null || facts === undefined || !hasTemplateNews(facts)) return [];
  return [
    { type: 'heading', text: 'Templates' },
    {
      type: 'fields',
      items: [
        { label: 'Sites signed out', value: [text(formatCount(facts.signedOut))] },
        { label: 'Re-logins', value: [text(formatCount(facts.relogins))] },
        { label: 'Challenges', value: [text(formatCount(facts.challenges))] },
      ],
    },
  ];
}

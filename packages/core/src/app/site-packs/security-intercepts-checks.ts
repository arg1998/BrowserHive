/** @module app/site-packs/security-intercepts-checks — site checks (spec 13 §9.5): the site's health becomes `challenged` (`template.challenged`), `stop` stops the site, and an agent's session gets a `takeover` `security_intercept` within the bounds; a resolution probes the site. */

import type { SecurityInterceptOptions } from '@browserhive/contracts/http';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { ChallengeInput } from '../../ports/security-intercepts.ts';
import { type InterceptContext, interceptTimeoutMs } from './security-intercepts-types.ts';

/** The health reason of a session's site check (`template_probes.reason`). */
export function challengeReason(challengeId: string): string {
  return `challenge:${challengeId}`;
}

/** The site's health becomes `challenged`; `stop` also sets the site's `stopped_at`. Never throws. */
export async function markChallenged(ctx: InterceptContext, input: ChallengeInput): Promise<void> {
  const { deps } = ctx;
  try {
    const template = await deps.templates.get(input.templateId);
    if (template === null) return;
    if (input.challenge.action === 'stop') {
      const sites = await deps.templateSites.list(input.templateId);
      const site = sites.find((s) => s.siteId === input.site);
      if (site !== undefined && site.stoppedAt === null) {
        await deps.templateSites.upsert({ ...site, stoppedAt: deps.clock.now() });
      }
    }
    await deps.health?.record(
      template,
      input.site,
      {
        outcome: 'challenged',
        reason: challengeReason(input.challenge.id),
        finalUrl: input.pageUrl,
      },
      'attention',
    );
  } catch (error) {
    ctx.log.warn('challenge not recorded', { err: serializeError(error) });
  }
}

/**
 * Opens the session's site check unless the bounds say otherwise: at most one open per session
 * (a further match attaches to it), one new per session per 5 minutes, ten open intercepts per
 * template. Returns the request id now holding the session, or `null`.
 */
export async function openSiteCheck(
  ctx: InterceptContext,
  input: ChallengeInput,
): Promise<string | null> {
  const { deps, book } = ctx;
  const existing = book.challengeOf(input.sessionId);
  if (existing !== undefined) return existing.requestId;
  if (book.challengeTooSoon(input.sessionId, deps.clock.now())) return null;
  if (book.atBound(input.templateId, input.sessionId)) return null;
  const session = deps.sessions.peek(input.sessionId);
  if (session === undefined) return null;
  const options: SecurityInterceptOptions = {
    reason: 'challenge',
    site: input.site,
    site_title: input.siteTitle,
    pack_id: input.packId,
    template_id: input.templateId,
    challenge: input.challenge,
    url: input.pageUrl,
    source: 'page',
  };
  try {
    const handle = await deps.broker.open({
      kind: 'security_intercept',
      sessionId: input.sessionId,
      sessionSlug: session.slug,
      owner: session.owner,
      reason: `${input.siteTitle} security check`,
      mode: 'takeover',
      pageUrl: input.pageUrl,
      options,
      templateId: input.templateId,
      timeoutMs: interceptTimeoutMs(deps.config),
    });
    book.add({
      requestId: handle.id,
      sessionId: input.sessionId,
      templateId: input.templateId,
      site: input.site,
      siteTitle: input.siteTitle,
      reason: 'challenge',
      createdAt: handle.createdAt,
    });
    void handle.promise.then((outcome) => {
      book.remove(handle.id);
      // A resolution triggers a probe of the site (spec 13 §9.5 "Resolving").
      if (outcome.status === 'resolved') probeSite(ctx, input.templateId, input.site);
    });
    return handle.id;
  } catch (error) {
    ctx.log.warn('site check not opened', { err: serializeError(error) });
    return null;
  }
}

function probeSite(ctx: InterceptContext, templateId: string, site: string): void {
  const health = ctx.deps.health;
  if (health === null) return;
  void health
    .probe(templateId, { trigger: 'attention', siteIds: [site], start: 'never' })
    .catch((error: unknown) =>
      ctx.log.warn('site check probe failed', { err: serializeError(error) }),
    );
}

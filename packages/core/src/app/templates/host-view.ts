/** @module app/templates/host-view — a template's host as operator surfaces show it (`HostView`, spec 13 §11.1), from its lifecycle. */

import { sanitizeUrl } from '../../kernel/url.ts';
import { STOPPED_HOST, type TemplateHostView } from '../../ports/template-runtime.ts';
import type { HostLifecycle } from './host-lifecycle.ts';
import { recycleAt } from './host-state.ts';

/** The view of `lifecycle` (absent = a host that never ran in this process). */
export function hostViewOf(
  lifecycle: HostLifecycle | undefined,
  facts: {
    readonly liveAgentSessions: number;
    readonly rssBytes: number | null;
    readonly recycleAfterMs: number;
  },
): TemplateHostView {
  if (lifecycle === undefined)
    return { ...STOPPED_HOST, liveAgentSessions: facts.liveAgentSessions };
  const host = lifecycle.current;
  return {
    state: lifecycle.state,
    liveAgentSessions: facts.liveAgentSessions,
    since: lifecycle.since,
    startedAt: lifecycle.startedAt,
    restarts: lifecycle.restarts,
    lastError: lifecycle.failure ?? lifecycle.lastError,
    pages: host?.agentPageCount() ?? 0,
    parkedPages:
      host?.parkedPages().map((p) => ({
        targetId: p.targetId,
        url: sanitizeUrl(p.url),
        title: '',
        openedAt: p.openedAt,
      })) ?? [],
    // Read live by `GET /templates/{id}` (`TemplateHostOps.sharedWindows`): it needs the browser.
    sharedWindows: [],
    rssBytes: facts.rssBytes,
    recycleAt: recycleAt(lifecycle.startedAt, facts.recycleAfterMs),
    sandboxed: host?.browserInfo?.sandboxed ?? null,
    profileSecrets: host?.profileSecrets ?? lifecycle.profileSecrets,
  };
}

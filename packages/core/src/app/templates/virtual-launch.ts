/** @module app/templates/virtual-launch — turns a template launch into the session pipeline's inputs (spec 13 §3.7): the exclusive-shaped input built from the template's settings only, and the `VirtualSessionLauncher` over one host lifecycle. */

import type { CreateSessionInput } from '../../domain/session/create-request.ts';
import type { SessionTemplate } from '../../domain/session/session-template.ts';
import type { PageCaps } from '../../domain/templates/model.ts';
import { isAppError } from '../../kernel/errors/app-error.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { TemplateRecord, TemplateSiteRecord } from '../../ports/persistence/index.ts';
import type { TemplateLaunchRequest } from '../../ports/template-runtime.ts';
import type { VirtualSessionLauncher } from '../sessions/pipeline-context.ts';
import type { HostLifecycle } from './host-lifecycle.ts';
import { admitNewPage, templateUnavailable } from './template-admission.ts';

/**
 * The session input of a virtual session: every value from the template's settings (spec 13 §5.3),
 * never the agent's raw arguments; the three per-session context options are validated by the
 * pipeline like any session's.
 */
export function virtualSessionInput(request: TemplateLaunchRequest): CreateSessionInput {
  const s = request.settings;
  const context = s.contextOptions;
  const contextOptions = {
    ...(context.viewport !== undefined && { viewport: context.viewport }),
    ...(context.extraHTTPHeaders !== undefined && { extraHTTPHeaders: context.extraHTTPHeaders }),
    ...(context.colorScheme !== undefined && { colorScheme: context.colorScheme }),
  };
  return {
    slug: request.slug,
    channel: s.channel,
    headless: s.headless,
    incognito: s.incognito,
    persistenceMode: s.persistenceMode,
    disableEvaluate: s.disableEvaluate,
    vaultEnabled: s.vaultEnabled,
    stealth: s.stealth,
    fingerprint: s.fingerprint,
    humanize: s.humanize,
    ...(Object.keys(contextOptions).length > 0 && { contextOptions }),
    connectionId: request.connectionId,
    client: request.client,
  };
}

/** The template a session records (enabled sites with their health at launch). */
export function sessionTemplateOf(
  template: TemplateRecord,
  sites: readonly TemplateSiteRecord[],
  mode: SessionTemplate['mode'],
  sealed: boolean,
): SessionTemplate {
  return {
    templateId: template.templateId,
    name: template.name,
    version: template.currentVersion,
    mode,
    sealed,
    sites: sites.filter((s) => s.enabled).map((s) => ({ site: s.siteId, status: s.health.state })),
  };
}

/** The pipeline's launcher over `lifecycle` for one session. */
export function virtualLauncher(input: {
  readonly lifecycle: HostLifecycle;
  readonly template: TemplateRecord;
  readonly session: SessionTemplate;
  readonly caps: PageCaps | null;
  /** A site-opened page over the session's cap was closed. */
  readonly onPageLimit?: (sessionId: string) => void;
}): VirtualSessionLauncher {
  const { lifecycle, template, caps } = input;
  const name = template.name;
  return {
    template: input.session,
    proxyLabel: template.proxy?.label ?? null,
    reserve: (admitSlot) => lifecycle.reserve(admitSlot),
    acquire: async (signal) => {
      await lifecycle.acquire(signal);
    },
    open: async (sessionId, { pageOptions, signal }) => {
      const host = lifecycle.running;
      if (host === null) throw lifecycle.refusal();
      try {
        return await host.openView(sessionId, {
          windowState: template.agentWindows,
          pageOptions,
          ...(input.session.mode === 'maintenance' && { maintenance: true }),
          signal,
          // Maintenance sessions are bounded by nothing but their own work (spec 13 §6.3).
          ...(caps !== null && {
            beforeNewPage: () =>
              admitNewPage(name, caps, host.agentPageCount(), host.sessionPageCount(sessionId)),
            pageLimit: caps.perSession,
            onPageLimit: () => input.onPageLimit?.(sessionId),
          }),
        });
      } catch (err) {
        if (isAppError(err) && err.code.startsWith('TEMPLATE_')) throw err;
        throw templateUnavailable(name, 'starting', undefined, serializeError(err).message);
      }
    },
  };
}

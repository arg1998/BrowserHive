/** @module app/site-packs/probe-pages — the page a pack probe navigates in (spec 13 §8.1): a maintenance session of the template's host owned by `browserhive` (never an agent's, no cap, no lease), its window minimized on a headed host, closed after the probe. */

import type { Page } from 'patchright';
import { AppError } from '../../kernel/errors/app-error.ts';
import type { TemplateRecord, TemplateSiteRecord } from '../../ports/persistence/index.ts';
import type { MaintenanceLaunch } from '../templates/host-supervisor-types.ts';
import type { ProbePage } from './pack-prober.ts';

/** The slug of BrowserHive's own maintenance sessions. */
const PROBE_SLUG = 'maintenance';

/** What the opener needs: the supervisor's maintenance launch and the session close. */
export interface ProbePagesDeps {
  readonly launchMaintenance: (input: MaintenanceLaunch) => Promise<{
    readonly id: string;
    readonly view: { readonly page: Page } | null;
  }>;
  readonly close: (sessionId: string) => Promise<unknown>;
}

/** Opens probe pages through maintenance sessions. */
export function maintenanceProbePages(
  deps: ProbePagesDeps,
): (template: TemplateRecord, site: TemplateSiteRecord, signal: AbortSignal) => Promise<ProbePage> {
  return async (template, site, signal) => {
    const session = await deps.launchMaintenance({
      template,
      sites: [site],
      slug: PROBE_SLUG,
      principal: { subject: 'browserhive' },
      background: true,
      signal,
    });
    let closed: Promise<unknown> | null = null;
    const close = async (): Promise<void> => {
      closed ??= deps.close(session.id).catch(() => undefined);
      await closed;
    };
    const page = session.view?.page;
    if (page === undefined) {
      await close();
      throw new AppError(
        'INTERNAL_ERROR',
        { ref: 'probe-page' },
        { message: 'the probe session has no page' },
      );
    }
    return { page, close };
  };
}

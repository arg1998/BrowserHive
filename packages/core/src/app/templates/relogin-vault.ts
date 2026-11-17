/** @module app/templates/relogin-vault — vault auto-relogin (spec 13 §8.4): BrowserHive fills the linked binding into the site's sign-in page in a maintenance session of the template's browser, as the synthetic principal `template:<template_id>`, slug `relogin` and no harness, through every gate of the vault broker; one try per sign-out, none within 24 h of the last. */

import type { Session } from '../../domain/session/session.ts';
import type {
  VaultFillContext,
  VaultFillRequest,
  VaultFillResult,
  VaultPage,
} from '../../domain/vault/types.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Clock } from '../../ports/clock.ts';
import type { Logger } from '../../ports/logger.ts';
import type {
  Repositories,
  TemplateRecord,
  TemplateSiteRecord,
} from '../../ports/persistence/index.ts';
import type { SessionService } from '../sessions/session-service.ts';
import type { TemplateHostSupervisor } from './host-supervisor.ts';
import type { TemplateHealthService } from './template-health.ts';

/** The principal a template's auto-relogin acts as (no token, never matched from a credential). */
export function templatePrincipal(templateId: string): string {
  return `template:${templateId}`;
}

/** An automatic re-login is not tried again within this long of the last try (spec 13 §8.4). */
export const AUTO_RELOGIN_RETRY_MS = 24 * 60 * 60_000;
/** How long the sign-in page may take to load. */
const SIGN_IN_LOAD_MS = 20_000;
/** How long the site gets after the submit before the probe. */
const AFTER_SUBMIT_MS = 3_000;

/** What auto-relogin needs from the vault (`VaultService` satisfies it). */
export interface ReloginVault {
  readonly configured: boolean;
  fill(request: VaultFillRequest, ctx: VaultFillContext): Promise<VaultFillResult>;
}

/** The outcome of one fill. */
export type VaultReloginOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

/** Collaborators of {@link ReloginVaultFill}. */
export interface ReloginVaultDeps {
  readonly vault: ReloginVault;
  readonly supervisor: Pick<TemplateHostSupervisor, 'launchMaintenance'>;
  readonly sessions: Pick<SessionService, 'close'>;
  readonly health: Pick<TemplateHealthService, 'probe'>;
  readonly repos: Pick<Repositories, 'templateSites'>;
  readonly clock: Clock;
  readonly logger: Logger;
}

/** Fills a template site's linked binding. */
export class ReloginVaultFill {
  readonly #deps: ReloginVaultDeps;
  readonly #log: Logger;

  constructor(deps: ReloginVaultDeps) {
    this.#deps = deps;
    this.#log = deps.logger.child({ module: 'templates.relogin.vault' });
  }

  /** An automatic try is allowed: none in the last 24 h. */
  mayRetry(site: TemplateSiteRecord): boolean {
    const last = site.autoReloginAt;
    return last === null || this.#deps.clock.now() - last >= AUTO_RELOGIN_RETRY_MS;
  }

  /**
   * One fill: records the try (automatic ones), opens the maintenance session, loads the sign-in
   * page, fills through the broker and probes the site. Never throws for a refused fill.
   */
  async fill(
    template: TemplateRecord,
    site: TemplateSiteRecord,
    trigger: 'manual' | 'auto',
    opened: (sessionId: string) => void,
  ): Promise<VaultReloginOutcome> {
    const { form, vaultHandle } = site;
    if (form === null || vaultHandle === null) return { ok: false, error: 'not_linked' };
    let session: Session;
    try {
      session = await this.#deps.supervisor.launchMaintenance({
        template,
        sites: [site],
        slug: 'relogin',
        principal: { subject: template.owner },
      });
    } catch (err) {
      // No browser (an operation holds the template, no slot, a failed browser): nothing was tried,
      // so the 24 h rule is not spent (review #81 L-3).
      this.#log.warn('auto-relogin not started', {
        templateId: template.templateId,
        err: serializeError(err),
      });
      return { ok: false, error: 'browser_unavailable' };
    }
    // Only a try that runs counts toward the 24 h rule.
    if (trigger === 'auto') {
      await this.#deps.repos.templateSites.upsert({
        ...site,
        autoReloginAt: this.#deps.clock.now(),
      });
    }
    opened(session.id);
    try {
      const page = session.view?.page;
      if (page === undefined) return { ok: false, error: 'no_page' };
      await page.goto(`https://${site.siteId}${form.path ?? '/'}`, {
        waitUntil: 'domcontentloaded',
        timeout: SIGN_IN_LOAD_MS,
      });
      const result = await this.#deps.vault.fill(
        {
          entryName: vaultHandle,
          usernameSelector: form.username,
          passwordSelector: form.password,
          ...(form.submit !== undefined && { submitSelector: form.submit }),
          afterSubmitWaitMs: AFTER_SUBMIT_MS,
          clearAfterFill: false,
        },
        fillContext(template, site, session, page as unknown as VaultPage),
      );
      if (result.status !== 'success') return { ok: false, error: result.reason ?? result.status };
      const run = await this.#deps.health.probe(template.templateId, {
        trigger: 'relogin',
        siteIds: [site.siteId],
        start: 'never',
      });
      const outcome = run?.[0]?.outcome;
      return outcome === 'signed_in' ? { ok: true } : { ok: false, error: 'still_signed_out' };
    } catch (err) {
      this.#log.warn('auto-relogin failed', {
        templateId: template.templateId,
        site: site.siteId,
        err: serializeError(err),
      });
      return { ok: false, error: 'fill_failed' };
    } finally {
      await this.#deps.sessions.close(session.id, 'operator').catch(() => undefined);
    }
  }
}

/** The broker's context for a template fill: every gate as for an agent, with the template as the principal. */
function fillContext(
  template: TemplateRecord,
  site: TemplateSiteRecord,
  session: Session,
  page: VaultPage,
): VaultFillContext {
  return {
    session: {
      sessionId: session.id,
      slug: 'relogin',
      disableEvaluate: true,
      vaultEnabled: true,
      humanize: false,
      harness: null,
      harnessDeclared: null,
      // A maintenance session of this template (from `template_mode`, never the slug): it
      // satisfies the binding's session rule for `template:<id>` (review #81 M-1).
      maintenanceOf: session.template?.mode === 'maintenance' ? session.template.templateId : null,
    },
    page,
    tracing: null,
    principal: templatePrincipal(template.templateId),
    autoRelogin: { templateId: template.templateId, linkedBy: site.vaultLinkedBy },
  };
}

/** @module app/templates/relogin-window — the sign-in window of a re-login (spec 13 §8.4): a window on the BrowserHive machine (a stopped headless template starts headed for it when a display is available), else the maintenance session's live view; the 5 s watch that finishes only on an observed sign-in (review #81 M-5); the deadline; and the agents' pause (D-60), which in the live view lasts only while the operator signs in. */

import type { SessionPrincipal } from '../../domain/session/principal.ts';
import type { Session } from '../../domain/session/session.ts';
import { classifyGenericProbe } from '../../domain/templates/probe.ts';
import { cookieSite, type JarCookie, jarNames } from '../../domain/templates/sign-ins.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type {
  Repositories,
  TemplateRecord,
  TemplateSiteRecord,
} from '../../ports/persistence/index.ts';
import type { TemplateHostOperations } from './host-operations.ts';
import type { TemplateHostSupervisor } from './host-supervisor.ts';
import type { ReloginRuns, Running, SiteBaseline } from './relogin-runs.ts';

/** The slug of a re-login's maintenance session (spec 13 §1.1). */
export const RELOGIN_SLUG = 'relogin';
/** How long a re-login window waits for the sign-in (spec 13 §8.4). */
export const RELOGIN_WINDOW_MS = 30 * 60_000;
/** How often the window's cookies are checked. */
export const RELOGIN_POLL_MS = 5_000;
/** Agents resume when a live-view sign-in sees no input for this long (they wait again on the next). */
export const LIVE_SIGN_IN_IDLE_MS = 120_000;

/** What a window needs. */
export interface ReloginWindowDeps {
  readonly runs: ReloginRuns;
  readonly repos: Pick<Repositories, 'templates' | 'templateSites'>;
  readonly supervisor: Pick<TemplateHostSupervisor, 'pause' | 'host'>;
  readonly ops: Pick<
    TemplateHostOperations,
    'openSignInWindow' | 'raiseWindow' | 'recordingOf' | 'jar' | 'held'
  >;
  /** A headed browser can open a window on this machine (Linux: `DISPLAY` or `WAYLAND_DISPLAY`). */
  readonly displayAvailable: () => boolean;
}

/** The site's learned cookies in the jar, with their expiry. */
export function learnedPresent(
  site: Pick<TemplateSiteRecord, 'siteId' | 'learnedCookieNames'>,
  jar: readonly Pick<JarCookie, 'name' | 'domain' | 'expires'>[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (const cookie of jar) {
    if (cookieSite(cookie) === site.siteId && site.learnedCookieNames.includes(cookie.name)) {
      out.set(cookie.name, cookie.expires);
    }
  }
  return out;
}

/**
 * The site was signed in during the window: the generic probe reads `signed_in` and a learned
 * cookie appeared or changed expiry since the window opened. A site whose cookies were all there
 * already never finishes by itself (the operator presses **Done**).
 */
export function signedInSince(
  baseline: SiteBaseline,
  site: Pick<TemplateSiteRecord, 'siteId' | 'learnedCookieNames'>,
  jar: readonly Pick<JarCookie, 'name' | 'domain' | 'expires'>[],
  now: number,
): boolean {
  if (classifyGenericProbe(site, jar, now).outcome !== 'signed_in') return false;
  for (const [name, expires] of learnedPresent(site, jar)) {
    const before = baseline.learned.get(name);
    if (before === undefined || before !== expires) return true;
  }
  return false;
}

/** Opening and watching re-login windows. */
export class ReloginWindows {
  readonly #deps: ReloginWindowDeps;

  constructor(deps: ReloginWindowDeps) {
    this.#deps = deps;
  }

  /**
   * Opens the run's window. A run replaced or ended meanwhile closes the window it got, so no
   * window is ever left without a run (review #81 H-1).
   */
  async open(
    run: Running,
    template: TemplateRecord,
    site: TemplateSiteRecord,
    principal: SessionPrincipal,
    letAgentsContinue: boolean,
  ): Promise<void> {
    const { runs, ops, supervisor, repos } = this.#deps;
    const via = this.#via(template);
    const sites = await repos.templateSites.list(template.templateId);
    let session: Session;
    try {
      session = await ops.openSignInWindow(
        {
          // A stopped headless template starts headed for its re-login (spec 13 §8.4).
          template:
            via === 'window' && template.headless ? { ...template, headless: false } : template,
          sites,
          siteIds: [site.siteId],
          principal,
          paths: site.form?.path === undefined ? {} : { [site.siteId]: site.form.path },
          letAgentsContinue,
          // In the live view agents wait only while the operator signs in (first input on).
          pauseAgents: via === 'window',
        },
        RELOGIN_SLUG,
      );
    } catch (err) {
      await runs.end(run, 'failed', 'window_failed');
      throw err;
    }
    if (!runs.current(run) || run.stop.signal.aborted) {
      await runs.closeWindow(template.templateId, session.id);
      return;
    }
    const jar = (await ops.jar(template.templateId)) ?? [];
    const learned = learnedPresent(site, jar);
    run.baseline = { names: jarNames(jar), learned };
    const confirmRequired =
      site.learnedCookieNames.length > 0 && site.learnedCookieNames.every((n) => learned.has(n));
    runs.publish(run, {
      state: 'open',
      session_id: session.id,
      deadline_at: runs.deps.clock.now() + RELOGIN_WINDOW_MS,
      sign_in_via: via,
      confirm_required: confirmRequired,
      agents_paused: supervisor.pause.paused(template.templateId),
    });
    void this.#watch(run, template, site.siteId);
  }

  /** Raises an open window (an explicit operator action). */
  async raise(run: Running): Promise<void> {
    const session = this.#deps.runs.session(run);
    if (session !== null) await this.#deps.ops.raiseWindow(session);
  }

  /**
   * An operator's input reached a live-view re-login: agents wait from now until the sign-in ends
   * or the operator stops for {@link LIVE_SIGN_IN_IDLE_MS}.
   */
  input(run: Running): void {
    const { runs, supervisor } = this.#deps;
    const session = run.view.session_id;
    if (session === null) return;
    run.lastInputAt = runs.deps.clock.now();
    if (!supervisor.pause.paused(run.templateId)) {
      supervisor.pause.open(run.templateId, session);
      runs.publish(run, { agents_paused: supervisor.pause.paused(run.templateId) });
    }
  }

  /** Window when the browser can show one; a headless template that runs, or no display: live view. */
  #via(template: TemplateRecord): 'window' | 'live_view' {
    if (!this.#deps.displayAvailable()) return 'live_view';
    if (!template.headless) return 'window';
    return this.#deps.supervisor.host(template.templateId).state === 'stopped'
      ? 'window'
      : 'live_view';
  }

  /** Every 5 s: the window, the site's cookies, the live-view idle rule, the deadline. */
  async #watch(run: Running, template: TemplateRecord, siteId: string): Promise<void> {
    const { runs, repos, ops, supervisor } = this.#deps;
    const clock = runs.deps.clock;
    try {
      while (runs.current(run) && run.view.state === 'open' && !run.stop.signal.aborted) {
        await clock.sleep(RELOGIN_POLL_MS, run.stop.signal).catch(() => undefined);
        if (!runs.current(run) || run.view.state !== 'open' || run.stop.signal.aborted) return;
        if (runs.session(run) === null) {
          const gone = (await repos.templates.get(template.templateId)) === null;
          const operation = ops.held(template.templateId);
          // A delete or an operation (restore, seed) closing the window is not a failed sign-in.
          if (gone || operation)
            await runs.end(run, 'cancelled', gone ? 'template_removed' : 'operation');
          else await runs.end(run, 'failed', 'window_closed');
          return;
        }
        const site = (await repos.templateSites.list(template.templateId)).find(
          (s) => s.siteId === siteId,
        );
        if (site === undefined) {
          await runs.end(run, 'cancelled', 'site_removed');
          return;
        }
        const now = clock.now();
        const session = run.view.session_id;
        if (
          run.view.sign_in_via === 'live_view' &&
          session !== null &&
          run.lastInputAt !== null &&
          now - run.lastInputAt > LIVE_SIGN_IN_IDLE_MS &&
          supervisor.pause.paused(template.templateId)
        ) {
          supervisor.pause.close(template.templateId, session);
          runs.publish(run, { agents_paused: false });
        }
        const jar = (await ops.jar(template.templateId)) ?? [];
        if (
          run.baseline !== null &&
          !run.view.confirm_required &&
          signedInSince(run.baseline, site, jar, now)
        ) {
          await runs.succeed(run, template, siteId, run.view.requested_by, 'relogin');
          return;
        }
        if (run.view.deadline_at !== null && now >= run.view.deadline_at) {
          await runs.end(run, 'timed_out', 'timed_out');
          return;
        }
      }
    } catch (err) {
      runs.deps.logger.warn('re-login watch failed', {
        templateId: run.templateId,
        err: serializeError(err),
      });
      await runs.end(run, 'failed', 'internal').catch(() => undefined);
    }
  }
}

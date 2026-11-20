/** @module app/templates/host-operations — `TemplateHostOps` over the host supervisor (spec 13 §2.3, §3.1, §3.4, §7.1): the recording window with one tab per site, removing a sign-in, shared windows and saved passwords. Never reachable by agents. */

import { join } from 'node:path';
import type { Session } from '../../domain/session/session.ts';
import { AppError } from '../../kernel/errors/app-error.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Cookie } from '../../ports/browser-driver.ts';
import type { Clock } from '../../ports/clock.ts';
import type { Logger } from '../../ports/logger.ts';
import type { Page } from '../../ports/page-types.ts';
import type { TemplateRecord } from '../../ports/persistence/index.ts';
import type {
  SignInRemoval,
  TemplateHost,
  TemplateHostLauncher,
} from '../../ports/template-host.ts';
import type {
  RecordingRequest,
  SharedWindowView,
  TemplateHostOps,
  TemplateOperationHold,
} from '../../ports/template-runtime.ts';
import type { SessionService } from '../sessions/session-service.ts';
import { templateDir } from './host-spec.ts';
import type { TemplateHostSupervisor } from './host-supervisor.ts';
import { recordingPage } from './recording-page.ts';

/** The slug of a recording's maintenance session (spec 13 §1.1). */
export const RECORDING_SLUG = 'recording';
/** The slug of BrowserHive's own maintenance session (starts a stopped browser for an operation). */
const SYSTEM_SLUG = 'maintenance';
/** How long a site tab may take to start loading before the window is shown anyway. */
const SITE_TAB_COMMIT_MS = 15_000;

/** Collaborators of {@link TemplateHostOperations}. */
export interface HostOperationsDeps {
  readonly supervisor: TemplateHostSupervisor;
  readonly sessions: SessionService;
  readonly launcher: Pick<TemplateHostLauncher, 'clearProfileSecrets'>;
  readonly dataDir: string;
  readonly logger: Logger;
  readonly clock: Clock;
  /** `templateDrainTimeout`: how long an operation waits for sessions to finish. */
  readonly drainTimeoutMs: number;
}

/** The operator's operations on template browsers. */
export class TemplateHostOperations implements TemplateHostOps {
  readonly #deps: HostOperationsDeps;
  readonly #log: Logger;

  constructor(deps: HostOperationsDeps) {
    this.#deps = deps;
    this.#log = deps.logger.child({ module: 'templates.operations' });
  }

  async jar(templateId: string): Promise<readonly Cookie[] | null> {
    const host = this.#deps.supervisor.runningHost(templateId);
    return host === null ? null : await host.jar();
  }

  pageSites(templateId: string): ReadonlySet<string> {
    return this.#deps.supervisor.runningHost(templateId)?.pageSites?.() ?? new Set();
  }

  async sharedWindows(templateId: string): Promise<readonly SharedWindowView[]> {
    const host = this.#deps.supervisor.runningHost(templateId);
    if (host === null) return [];
    try {
      return await host.sharedWindows();
    } catch (err) {
      this.#log.debug('shared windows unreadable', { err: serializeError(err) });
      return [];
    }
  }

  async removeSignIn(template: TemplateRecord, domain: string): Promise<SignInRemoval> {
    return await this.withHost(template, (host) => host.clearSignIn(domain));
  }

  async withHost<T>(
    template: TemplateRecord,
    fn: (host: TemplateHost) => Promise<T>,
    holdToken?: symbol,
  ): Promise<T> {
    const { supervisor } = this.#deps;
    let host = supervisor.runningHost(template.templateId);
    let system: Session | null = null;
    if (host === null) {
      // Start the browser through BrowserHive's own session, then let it idle as usual.
      system = await supervisor.launchMaintenance({
        template,
        sites: [],
        slug: SYSTEM_SLUG,
        principal: { subject: 'browserhive' },
        ...(holdToken !== undefined && { holdToken }),
      });
      host = supervisor.runningHost(template.templateId);
    }
    try {
      if (host === null) throw notRunning();
      return await fn(host);
    } finally {
      if (system !== null) await this.#deps.sessions.close(system.id, 'operator');
    }
  }

  /** Stops the browser and empties saved passwords; launches wait meanwhile (D17). */
  async clearProfileSecrets(template: TemplateRecord): Promise<void> {
    const hold = this.hold(template.templateId);
    if (hold === null) throw busy();
    try {
      await this.#deps.supervisor.stopHost(template.templateId, 'clear saved passwords');
      const userDataDir = join(templateDir(this.#deps.dataDir, template.templateId), 'userdata');
      await this.#deps.launcher.clearProfileSecrets?.(userDataDir);
    } finally {
      hold.release();
    }
  }

  held(templateId: string): boolean {
    return this.#deps.supervisor.holds.held(templateId);
  }

  hold(templateId: string): TemplateOperationHold | null {
    return this.#deps.supervisor.holds.hold(templateId);
  }

  async startHost(template: TemplateRecord): Promise<void> {
    this.#deps.supervisor.lifecycle(template).clearFailure();
    await this.withHost(template, async () => undefined);
  }

  async stopHost(template: TemplateRecord): Promise<readonly string[]> {
    const live = this.#deps.supervisor.liveSessions(template.templateId);
    await this.#deps.supervisor.stopHost(template.templateId, 'operator stop');
    return live;
  }

  async restartHost(template: TemplateRecord): Promise<void> {
    const { supervisor } = this.#deps;
    const lifecycle = supervisor.lifecycle(template);
    lifecycle.clearFailure();
    if (lifecycle.running === null) {
      await this.startHost(template);
      return;
    }
    // In the background: the drain may wait up to `templateDrainTimeout` for sessions.
    void supervisor
      .recycle(lifecycle, 'operator')
      .then(() => this.startHost(template))
      .catch((err: unknown) =>
        this.#log.warn('host restart failed', {
          templateId: template.templateId,
          err: serializeError(err),
        }),
      );
  }

  async closeParkedPage(templateId: string, targetId: string): Promise<boolean> {
    const host = this.#deps.supervisor.runningHost(templateId);
    return host === null ? false : await host.closePage(targetId, 'parked');
  }

  async drainForOperation(
    template: TemplateRecord,
    forceClose: boolean,
  ): Promise<readonly string[]> {
    const { supervisor, sessions, clock } = this.#deps;
    const id = template.templateId;
    const live = () => supervisor.liveSessions(id);
    const closed = [...live()];
    if (!forceClose) {
      const until = clock.now() + this.#deps.drainTimeoutMs;
      while (live().length > 0 && clock.now() < until) {
        await clock.sleep(Math.min(1_000, until - clock.now()));
      }
    }
    const rest = supervisor.sessionsOf(id, null).map((s) => s.id);
    await Promise.allSettled(rest.map((sid) => sessions.close(sid, 'operator')));
    await supervisor.stopHost(id, 'operation');
    return closed.filter((sid) => !live().includes(sid));
  }

  async discardHost(template: TemplateRecord): Promise<void> {
    await this.#deps.supervisor.lifecycle(template).stop('operation timed out', 'operator', false);
  }

  recordingOf(templateId: string): Session | null {
    const open = this.#deps.supervisor
      .sessionsOf(templateId, 'maintenance')
      .filter((s) => s.slug === RECORDING_SLUG && s.view !== null);
    return open[0] ?? null;
  }

  async openRecording(request: RecordingRequest): Promise<Session> {
    const open = this.recordingOf(request.template.templateId);
    if (open !== null) {
      await raise(await this.#signInPage(open, request.siteIds));
      return open;
    }
    return this.openSignInWindow(request, RECORDING_SLUG);
  }

  /**
   * Opens a sign-in window (a maintenance session owned by the operator, agent windows minimized
   * meanwhile, spec 13 §3.3): the marker tab with the instructions, then one tab per site at
   * `https://<site><path>` (a recording, or a re-login with slug `relogin`, §8.4).
   */
  async openSignInWindow(
    request: RecordingRequest & {
      readonly paths?: Readonly<Record<string, string>>;
      /** Agents keep working while the window is open (the urgent override, D-60). */
      readonly letAgentsContinue?: boolean;
      /** `false`: the window does not pause agents by itself (a live-view re-login pauses on input). */
      readonly pauseAgents?: boolean;
    },
    slug: string,
  ): Promise<Session> {
    const { supervisor } = this.#deps;
    const session = await supervisor.launchMaintenance({
      template: request.template,
      sites: request.sites,
      slug,
      principal: request.principal,
      recording: true,
    });
    // Agents wait while the operator signs in (D-60); the pause ends with the window.
    if (request.pauseAgents !== false) {
      supervisor.pause.open(request.template.templateId, session.id, request.letAgentsContinue);
    }
    try {
      await this.#openTabs(session, request.siteIds, request.paths ?? {});
    } catch (err) {
      this.#log.warn('sign-in tabs incomplete', { err: serializeError(err) });
    }
    return session;
  }

  /** Raises a sign-in window (**Show window**: an explicit operator action, spec 13 §3.3). */
  async raiseWindow(session: Session): Promise<void> {
    await raise(await this.#signInPage(session, null));
  }

  /**
   * A page of the sign-in window to show: an open one, or, when the operator closed the window by
   * hand (the browser stays up with no window, D-78), a new window with the instructions.
   */
  async #signInPage(
    session: Session,
    siteIds: readonly string[] | null,
  ): Promise<Page | undefined> {
    const view = session.view;
    if (view === null) return undefined;
    const open = [view.page, ...view.pages()].find((page) => !page.isClosed());
    if (open !== undefined) return open;
    try {
      const { page } = await this.#deps.sessions.newTab(session);
      if (siteIds !== null) await page.setContent(recordingPage(siteIds));
      return page;
    } catch (err) {
      this.#log.debug('sign-in window not opened', { err: serializeError(err) });
      return undefined;
    }
  }

  async closeRecording(templateId: string): Promise<void> {
    const ids = this.#deps.supervisor
      .sessionsOf(templateId, 'maintenance')
      .filter((s) => s.slug === RECORDING_SLUG)
      .map((s) => s.id);
    await Promise.allSettled(ids.map((id) => this.#deps.sessions.close(id, 'operator')));
  }

  /**
   * The window's first tab carries the BrowserHive marker and the instructions (spec 13 §3.3); one
   * tab per site follows at `https://<site>/`. The session's active tab is the first site (what
   * the live view shows); the window is raised on the marker tab, an explicit operator action.
   */
  async #openTabs(
    session: Session,
    siteIds: readonly string[],
    paths: Readonly<Record<string, string>>,
  ): Promise<void> {
    const view = session.view;
    if (view === null) return;
    await view.page.setContent(recordingPage(siteIds));
    let first: string | null = null;
    for (const site of siteIds) {
      const { tabId, page } = await this.#deps.sessions.newTab(session);
      first ??= tabId;
      await page
        .goto(`https://${site}${paths[site] ?? '/'}`, {
          waitUntil: 'commit',
          timeout: SITE_TAB_COMMIT_MS,
        })
        .catch((err: unknown) => this.#log.debug('site tab', { err: serializeError(err) }));
    }
    if (first !== null) this.#deps.sessions.switchTab(session, first);
    await raise(view.page);
  }
}

/** `CONFLICT`: the browser could not be started for the operation. */
function notRunning(): AppError<'CONFLICT'> {
  return new AppError(
    'CONFLICT',
    {},
    { publicMessage: "The template's browser is not running and could not be started." },
  );
}

/** `CONFLICT`: another operation (restore, seed, clearing saved passwords) is running. */
export function busy(): AppError<'CONFLICT'> {
  return new AppError(
    'CONFLICT',
    {},
    {
      publicMessage:
        'Another operation on this template is running (a restore, a seed or clearing saved passwords); retry when it finishes.',
    },
  );
}

/** Shows the window of `page` in front (recording is an explicit operator action, spec 13 §3.3). */
async function raise(page: Page | undefined): Promise<void> {
  await page?.bringToFront().catch(() => undefined);
}

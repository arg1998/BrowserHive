/** @module app/templates/host-operations — `TemplateHostOps` over the host supervisor (spec 13 §2.3, §3.1, §3.4, §7.1): the recording window with one tab per site, removing a sign-in, shared windows and saved passwords. Never reachable by agents. */

import { join } from 'node:path';
import type { Session } from '../../domain/session/session.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Cookie } from '../../ports/browser-driver.ts';
import type { Logger } from '../../ports/logger.ts';
import type { Page } from '../../ports/page-types.ts';
import type { TemplateRecord } from '../../ports/persistence/index.ts';
import type { TemplateHostLauncher } from '../../ports/template-host.ts';
import type {
  RecordingRequest,
  SharedWindowView,
  TemplateHostOps,
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

  async removeSignIn(template: TemplateRecord, domain: string): Promise<number> {
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
      });
      host = supervisor.runningHost(template.templateId);
    }
    try {
      return host === null ? 0 : await host.clearSignIn(domain);
    } finally {
      if (system !== null) await this.#deps.sessions.close(system.id, 'operator');
    }
  }

  async clearProfileSecrets(template: TemplateRecord): Promise<void> {
    await this.#deps.supervisor.stopHost(template.templateId, 'clear saved passwords');
    const userDataDir = join(templateDir(this.#deps.dataDir, template.templateId), 'userdata');
    await this.#deps.launcher.clearProfileSecrets?.(userDataDir);
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
      await raise(open.view?.page);
      return open;
    }
    const session = await this.#deps.supervisor.launchMaintenance({
      template: request.template,
      sites: request.sites,
      slug: RECORDING_SLUG,
      principal: request.principal,
      recording: true,
    });
    try {
      await this.#openTabs(session, request.siteIds);
    } catch (err) {
      this.#log.warn('recording tabs incomplete', { err: serializeError(err) });
    }
    return session;
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
  async #openTabs(session: Session, siteIds: readonly string[]): Promise<void> {
    const view = session.view;
    if (view === null) return;
    await view.page.setContent(recordingPage(siteIds));
    let first: string | null = null;
    for (const site of siteIds) {
      const { tabId, page } = await this.#deps.sessions.newTab(session);
      first ??= tabId;
      await page
        .goto(`https://${site}/`, { waitUntil: 'commit', timeout: SITE_TAB_COMMIT_MS })
        .catch((err: unknown) => this.#log.debug('site tab', { err: serializeError(err) }));
    }
    if (first !== null) this.#deps.sessions.switchTab(session, first);
    await raise(view.page);
  }
}

/** Shows the window of `page` in front (recording is an explicit operator action, spec 13 §3.3). */
async function raise(page: Page | undefined): Promise<void> {
  await page?.bringToFront().catch(() => undefined);
}

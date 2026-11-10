/** @module ports/template-runtime — the seam between the template service (data, access, contracts) and the template hosts (spec 13 §3): host facts for operator views and agent availability, the virtual-session launch, and the shutdown that precedes a delete. Implemented by the host supervisor (templates T1a-2); until then `UnavailableTemplateRuntime` answers every launch with `TEMPLATE_UNAVAILABLE`. */

import type { SessionClientInfo } from '../domain/session/client-info.ts';
import type { SessionPrincipal } from '../domain/session/principal.ts';
import type { Session } from '../domain/session/session.ts';
import type { TemplateSessionSettings } from '../domain/templates/launch-options.ts';
import type { SessionSealing, TemplateHostFacts } from '../domain/templates/model.ts';
import type { Cookie } from './browser-driver.ts';
import type { TemplateRecord, TemplateSiteRecord } from './persistence/index.ts';
import type { SignInRemoval } from './template-host.ts';

/** A page of a host no session owns (spec 13 §3.4); `url` already sanitized (D-20). */
export interface ParkedPageView {
  readonly targetId: string;
  readonly url: string;
  readonly title: string;
  readonly openedAt: number;
}

/** A window that shows pages of several sessions (spec 13 §3.4). */
export interface SharedWindowView {
  readonly windowId: number;
  readonly sessionIds: readonly string[];
}

/** A template's host as operator surfaces show it (`HostView`, spec 13 §11.1). */
export interface TemplateHostView extends TemplateHostFacts {
  /** When the host entered `state`; `null` for a host that never ran in this process. */
  readonly since: number | null;
  readonly startedAt: number | null;
  readonly restarts: number;
  /** Operator-facing cause of a `failed` or `crashed` host (`no_display`, …). */
  readonly lastError: string | null;
  /** Agent pages. */
  readonly pages: number;
  readonly parkedPages: readonly ParkedPageView[];
  readonly sharedWindows: readonly SharedWindowView[];
  readonly rssBytes: number | null;
  readonly recycleAt: number | null;
  /** `null` until the host has started. */
  readonly sandboxed: boolean | null;
  /** Saved passwords or autofill data were found in the profile at the last start (spec 13 §3.1). */
  readonly profileSecrets: boolean;
}

/** The host view of a template whose host never ran in this process. */
export const STOPPED_HOST: TemplateHostView = Object.freeze({
  state: 'stopped',
  liveAgentSessions: 0,
  since: null,
  startedAt: null,
  restarts: 0,
  lastError: null,
  pages: 0,
  parkedPages: [],
  sharedWindows: [],
  rssBytes: null,
  recycleAt: null,
  sandboxed: null,
  profileSecrets: false,
});

/**
 * A virtual-session launch that passed the `validate` phase of spec 13 §3.7: the template is
 * resolved, the caller may use it, and the launch options were applied (§5.3). The runtime runs the
 * remaining phases (`TemplateAdmission`, `reserve` with the template columns, host acquisition, the
 * window, policies, identity, register) within the 50 s launch budget.
 *
 * The agent's raw `launch_session` arguments never reach the runtime: it gets the slug, who asked,
 * and {@link TemplateSessionSettings}, in which every value is the template's or fixed for template
 * sessions except the few §5.3 lets an agent choose. Identity and proxy come from `template`.
 */
export interface TemplateLaunchRequest {
  readonly template: TemplateRecord;
  readonly sites: readonly TemplateSiteRecord[];
  /** The session slug (`<slug>-<nanoid8>`). */
  readonly slug: string;
  /** The MCP connection that launched it (`sessions.connection_id`). */
  readonly connectionId: string | null;
  /** The launching call's client; its harness becomes the session's launch harness (D-48). */
  readonly client: SessionClientInfo | null;
  readonly principal: SessionPrincipal;
  /** The protections in force for this principal (spec 13 §5.4). */
  readonly sealing: SessionSealing;
  /** `sessions.sealed`: any protection in force. */
  readonly sealed: boolean;
  /** The complete session settings (spec 13 §5.3, §5.5). */
  readonly settings: TemplateSessionSettings;
}

/** The host side of session templates. */
export interface TemplateRuntime {
  /** The host's facts and operator view (never shown to agents). */
  host(templateId: string): TemplateHostView;
  /** Ids of the live agent virtual sessions of a template (maintenance sessions excluded). */
  liveSessions(templateId: string): readonly string[];
  /**
   * Launches a virtual session (spec 13 §3.7 after `validate`).
   *
   * @throws AppError `TEMPLATE_DISABLED`, `TEMPLATE_UNAVAILABLE`, `TEMPLATE_BUSY`,
   *   `SESSION_LIMIT_REACHED` and the launch codes of exclusive sessions.
   */
  launch(request: TemplateLaunchRequest, signal?: AbortSignal): Promise<Session>;
  /**
   * Before a delete: closes the template's live sessions with `closed_reason: 'operator'`, stops its
   * host and resolves once nothing has the profile open. Returns the closed session ids.
   */
  shutdown(templateId: string): Promise<readonly string[]>;
}

/** Who opens a recording, and for which sites (spec 13 §7.1 step 5). */
export interface RecordingRequest {
  readonly template: TemplateRecord;
  readonly sites: readonly TemplateSiteRecord[];
  /** The sites that get a tab, in order. */
  readonly siteIds: readonly string[];
  /** The operator; the maintenance session is theirs (spec 13 §1.1). */
  readonly principal: SessionPrincipal;
}

/**
 * Operator operations on a template's browser (spec 13 §2.3, §3.1, §3.4, §7.1): the recording
 * window, the jar's sign-ins, shared windows and saved passwords. Implemented over the host
 * supervisor; never reachable by agents.
 */
export interface TemplateHostOps {
  /** Every cookie of the template's jar, or `null` when its browser is not running. */
  jar(templateId: string): Promise<readonly Cookie[] | null>;
  /** Windows that show pages of several sessions (`[]` when not running). */
  sharedWindows(templateId: string): Promise<readonly SharedWindowView[]>;
  /** Removes a registrable domain's cookies and site data, starting the browser when it is stopped. */
  removeSignIn(template: TemplateRecord, domain: string): Promise<SignInRemoval>;
  /** Stops the browser (its sessions close with `operator`) and empties saved passwords and autofill. */
  clearProfileSecrets(template: TemplateRecord): Promise<void>;
  /**
   * Opens the recording window (a maintenance session owned by the operator) with one tab per site,
   * or raises the one already open; agent windows are minimized meanwhile (spec 13 §3.3).
   *
   * @throws AppError `TEMPLATE_DISABLED`, `TEMPLATE_UNAVAILABLE`, `SESSION_LIMIT_REACHED`.
   */
  openRecording(request: RecordingRequest): Promise<Session>;
  /** The open recording session of a template, or `null`. */
  recordingOf(templateId: string): Session | null;
  /** Closes the recording window (its maintenance session); the template is unchanged. */
  closeRecording(templateId: string): Promise<void>;
}

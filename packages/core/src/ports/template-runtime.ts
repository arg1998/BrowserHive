/** @module ports/template-runtime — the seam between the template service (data, access, contracts) and the template hosts (spec 13 §3): host facts for operator views and agent availability, the virtual-session launch, and the shutdown that precedes a delete. Implemented by the host supervisor (templates T1a-2); until then `UnavailableTemplateRuntime` answers every launch with `TEMPLATE_UNAVAILABLE`. */

import type { SessionClientInfo } from '../domain/session/client-info.ts';
import type { CreateSessionInput } from '../domain/session/create-request.ts';
import type { SessionPrincipal } from '../domain/session/principal.ts';
import type { Session } from '../domain/session/session.ts';
import type { TemplateLaunchSettings } from '../domain/templates/launch-options.ts';
import type { SessionSealing, TemplateHostFacts } from '../domain/templates/model.ts';
import type { TemplateRecord, TemplateSiteRecord } from './persistence/index.ts';

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
 */
export interface TemplateLaunchRequest {
  readonly template: TemplateRecord;
  readonly sites: readonly TemplateSiteRecord[];
  /** The request as the tool received it (slug, connection, client); its option fields are already checked. */
  readonly input: CreateSessionInput;
  readonly principal: SessionPrincipal;
  readonly client: SessionClientInfo | null;
  /** The protections in force for this principal (spec 13 §5.4). */
  readonly sealing: SessionSealing;
  /** `sessions.sealed`: any protection in force. */
  readonly sealed: boolean;
  /** What the option rules kept: effective `disable_evaluate`, `humanize`, per-session context options. */
  readonly settings: TemplateLaunchSettings;
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

/** @module domain/session/session-template — what a virtual session knows about the template it was launched from (spec 13 §3.7 `reserve`, §5.2): the `sessions` template columns, its agent-facing `template` key and the maintenance flag. */

import type { TemplateHealthState } from '../../ports/persistence/enums.ts';

/** One site of the template as the session reports it (`session_info.template.sites`). */
export interface SessionTemplateSite {
  readonly site: string;
  readonly status: TemplateHealthState;
}

/**
 * The template of a virtual session, fixed at launch (`sessions.template_id`, `template_name`,
 * `template_version`, `template_mode`, `sealed`). Exclusive sessions have none.
 */
export interface SessionTemplate {
  readonly templateId: string;
  readonly name: string;
  /** `current_version` at launch. */
  readonly version: number | null;
  /**
   * `live`: an agent's virtual session. `maintenance`: BrowserHive's own (recording, re-login,
   * probes); never an agent's, never counted, no lease (spec 13 §1.1, §6.1).
   */
  readonly mode: 'live' | 'maintenance';
  /** Any protection in force (`sessions.sealed`, spec 13 §5.4). */
  readonly sealed: boolean;
  /** Enabled sites with their health at launch (spec 13 §5.2). */
  readonly sites: readonly SessionTemplateSite[];
}

/** True for a maintenance session (from `template_mode` only, never from the slug, spec 13 §1.1). */
export function isMaintenance(template: SessionTemplate | null | undefined): boolean {
  return template?.mode === 'maintenance';
}

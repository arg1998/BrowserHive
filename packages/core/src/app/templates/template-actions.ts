/** @module app/templates/template-actions — the operator's direct actions on a template's browser and versions (spec 13 §11.1 T1b, §11.8 audit): start, stop and restart the browser, close a parked page, save and pin versions, and the data-directory path for the reveal. Each action writes its `operator_actions` row. */

import type { HostView, TemplateVersionRow } from '@browserhive/contracts/http';
import type { Clock } from '../../ports/clock.ts';
import type { IdGenerator } from '../../ports/id-generator.ts';
import type { Logger } from '../../ports/logger.ts';
import type { Repositories, TemplateRecord } from '../../ports/persistence/index.ts';
import type { JsonObject } from '../../ports/persistence/json.ts';
import type { TemplateFiles } from '../../ports/template-files.ts';
import type { TemplateHostOps, TemplateRuntime } from '../../ports/template-runtime.ts';
import { disabled, notFoundForOperator, operationRunning } from './template-errors.ts';
import type { TemplateStateService } from './template-state.ts';
import { toHostView } from './views.ts';

/** Collaborators of {@link TemplateActions}. */
export interface TemplateActionsDeps {
  readonly repos: Pick<Repositories, 'templates' | 'operatorActions'>;
  readonly runtime: Pick<TemplateRuntime, 'host'>;
  readonly ops: Pick<
    TemplateHostOps,
    'startHost' | 'stopHost' | 'restartHost' | 'closeParkedPage' | 'held'
  >;
  readonly state: Pick<TemplateStateService, 'saveVersion' | 'pin'>;
  readonly files: Pick<TemplateFiles, 'dirOf'>;
  readonly ids: Pick<IdGenerator, 'eventId'>;
  readonly clock: Clock;
  readonly logger: Logger;
  /** The template's summary changed (`template.changed`). */
  readonly changed?: (templateId: string) => void;
}

/** Operator actions on a template's browser and versions. */
export class TemplateActions {
  readonly #deps: TemplateActionsDeps;

  constructor(deps: TemplateActionsDeps) {
    this.#deps = deps;
  }

  /**
   * `POST …/host/start|stop|restart`. A disabled template's browser cannot start.
   *
   * @throws AppError `TEMPLATE_NOT_FOUND`, `TEMPLATE_DISABLED`, and the start's refusals.
   */
  async host(
    templateId: string,
    action: 'start' | 'stop' | 'restart',
    by: string,
  ): Promise<HostView> {
    const template = await this.#template(templateId);
    if (action !== 'stop' && template.status === 'disabled') throw disabled(template.name);
    // A restore or seed restarts the browser itself (review #79 H-1).
    if (this.#deps.ops.held(templateId)) throw operationRunning(templateId);
    let details: JsonObject = {};
    if (action === 'start') await this.#deps.ops.startHost(template);
    else if (action === 'restart') await this.#deps.ops.restartHost(template);
    else details = { closed_sessions: [...(await this.#deps.ops.stopHost(template))] };
    await this.#audit(by, `template.host.${action}`, templateId, details);
    this.#deps.changed?.(templateId);
    return toHostView(this.#deps.runtime.host(templateId));
  }

  /**
   * `POST …/host/pages/{target_id}/close` (parked pages only).
   *
   * @throws AppError `TEMPLATE_NOT_FOUND` (template or page).
   */
  async closePage(templateId: string, targetId: string, by: string): Promise<void> {
    await this.#template(templateId);
    if (!(await this.#deps.ops.closeParkedPage(templateId, targetId))) {
      throw notFoundForOperator(templateId);
    }
    await this.#audit(by, 'template.page.close', templateId, { target_id: targetId });
  }

  /**
   * `POST …/versions` ("Save version now"): `null` when nothing changed since the newest version.
   *
   * @throws AppError `TEMPLATE_NOT_FOUND`, `CONFLICT` (the browser is not running).
   */
  async saveVersion(templateId: string, by: string): Promise<number | null> {
    await this.#template(templateId);
    const version = await this.#deps.state.saveVersion(templateId, {
      reason: 'manual',
      by,
      onlyIfChanged: true,
    });
    await this.#audit(by, 'template.version.save', templateId, { version });
    if (version !== null) this.#deps.changed?.(templateId);
    return version;
  }

  /**
   * `PATCH …/versions/{version}`.
   *
   * @throws AppError `TEMPLATE_NOT_FOUND`, `TEMPLATE_VERSION_NOT_FOUND`.
   */
  async pin(
    templateId: string,
    version: number,
    pinned: boolean,
    by: string,
  ): Promise<TemplateVersionRow> {
    await this.#template(templateId);
    const row = await this.#deps.state.pin(templateId, version, pinned);
    await this.#audit(by, 'template.version.pin', templateId, { version, pinned });
    return row;
  }

  /** `POST …/data-dir/reveal`: the directory to open (audited). */
  async dataDir(templateId: string, by: string): Promise<string> {
    await this.#template(templateId);
    await this.#audit(by, 'template.data_dir.reveal', templateId, {});
    return this.#deps.files.dirOf(templateId);
  }

  async #template(templateId: string): Promise<TemplateRecord> {
    const template = await this.#deps.repos.templates.get(templateId);
    if (template === null) throw notFoundForOperator(templateId);
    return template;
  }

  async #audit(by: string, action: string, templateId: string, details: JsonObject): Promise<void> {
    await this.#deps.repos.operatorActions.append({
      eventId: this.#deps.ids.eventId(),
      principalId: by,
      action,
      resourceKind: 'template',
      resourceId: templateId,
      details,
      occurredAt: this.#deps.clock.now(),
    });
  }
}

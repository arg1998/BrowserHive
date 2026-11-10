/** @module app/templates/template-operations — restore and seed as background operations (spec 13 §3.12, §7.4): validated synchronously (202 `{operation_id}`), then the template is held (agents get `TEMPLATE_UNAVAILABLE` `restarting`), its sessions are closed or waited for, the browser restarts, the state is applied in memory with `setStorageState`, and a `restore` or `import` version is written. Progress is on the `templates` topic and `GET /templates/operations/{id}`. */

import type { TemplateOperation, TemplateStorageState } from '@browserhive/contracts/http';
import { AppError, isAppError } from '../../kernel/errors/app-error.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Clock } from '../../ports/clock.ts';
import type { EventPublisher } from '../../ports/event-bus.ts';
import type { IdGenerator } from '../../ports/id-generator.ts';
import type { Logger } from '../../ports/logger.ts';
import type { Repositories, TemplateRecord } from '../../ports/persistence/index.ts';
import type { JsonObject } from '../../ports/persistence/json.ts';
import type { TemplateHostOps } from '../../ports/template-runtime.ts';
import type { StateSlot, TemplateState } from '../../ports/template-state.ts';
import type { DomainEvents } from '../events/catalog.ts';
import { busy } from './host-operations.ts';
import { inTemplateSpan } from './spans.ts';
import { disabled, notFoundForOperator } from './template-errors.ts';
import type { TemplateStateService } from './template-state.ts';

/** Operations kept for `GET /templates/operations/{id}` (oldest finished ones go first). */
const MAX_OPERATIONS = 200;

/** Collaborators of {@link TemplateOperations}. */
export interface TemplateOperationsDeps {
  readonly repos: Pick<Repositories, 'templates' | 'operatorActions'>;
  readonly ops: TemplateHostOps;
  readonly state: TemplateStateService;
  readonly ids: Pick<IdGenerator, 'opaque' | 'eventId'>;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly bus?: EventPublisher<DomainEvents>;
  /** Called when a template's row or summary changed (the `template.changed` event). */
  readonly changed?: (templateId: string) => void;
}

/** `CONFLICT` with an operator-facing message. */
function conflict(message: string): AppError<'CONFLICT'> {
  return new AppError('CONFLICT', {}, { publicMessage: message });
}

/** `NOT_FOUND` for an operation id (unknown, or forgotten after the last 200). */
function operationNotFound(id: string): AppError<'NOT_FOUND'> {
  return new AppError('NOT_FOUND', {}, { publicMessage: `No template operation '${id}'.` });
}

/** A Playwright storage state as BrowserHive keeps it in memory. */
function toState(input: TemplateStorageState): TemplateState {
  return {
    cookies: input.cookies.map((c) => ({ ...c })),
    origins: input.origins.map((o) => ({
      origin: o.origin,
      localStorage: o.localStorage.map((i) => ({ ...i })),
      ...(o.indexedDB !== undefined && { indexedDB: o.indexedDB }),
    })),
  };
}

/** Restore and seed. */
export class TemplateOperations {
  readonly #deps: TemplateOperationsDeps;
  readonly #log: Logger;
  readonly #operations = new Map<string, TemplateOperation>();

  constructor(deps: TemplateOperationsDeps) {
    this.#deps = deps;
    this.#log = deps.logger.child({ module: 'templates.operations' });
  }

  /**
   * `GET /templates/operations/{operation_id}`.
   *
   * @throws AppError `NOT_FOUND`.
   */
  get(operationId: string): TemplateOperation {
    const op = this.#operations.get(operationId);
    if (op === undefined) throw operationNotFound(operationId);
    return op;
  }

  /**
   * `POST /templates/{id}/versions/{version}/restore` (spec 13 §3.12). The version must exist and
   * be readable now (`TEMPLATE_VERSION_NOT_FOUND`, `TEMPLATE_VERSION_UNREADABLE`); the decrypted
   * state stays in memory.
   */
  async restore(
    templateId: string,
    slot: StateSlot,
    options: { readonly forceClose: boolean; readonly by: string },
  ): Promise<{ readonly operation_id: string }> {
    const template = await this.#template(templateId);
    const state = await this.#deps.state.read(templateId, slot);
    const restoredFrom = slot === 'latest' ? 0 : slot;
    return await this.#start(template, 'restore', options.by, {
      audit: {
        action: 'template.version.restore',
        details: { version: slot, force_close: options.forceClose },
      },
      run: (token) =>
        inTemplateSpan(
          'template.restore',
          { 'browserhive.template_id': templateId, 'browserhive.version': restoredFrom },
          async () => {
            const closed = await this.#deps.ops.drainForOperation(template, options.forceClose);
            const version = await this.#apply(template, state, token, {
              reason: 'restore',
              by: options.by,
              restoredFrom,
            });
            return { version, closed };
          },
        ),
    });
  }

  /**
   * `POST /templates/{id}/state` (spec 13 §7.4): a template in `recording`, or `ready` with
   * `confirm`; afterwards it is `ready`.
   *
   * @throws AppError `TEMPLATE_NOT_FOUND`, `TEMPLATE_DISABLED`, `CONFLICT` (ready without confirm).
   */
  async seed(
    templateId: string,
    input: TemplateStorageState,
    options: { readonly confirm: boolean; readonly by: string },
  ): Promise<{ readonly operation_id: string }> {
    const template = await this.#template(templateId);
    if (template.status === 'disabled') throw disabled(template.name);
    if (template.status === 'ready' && !options.confirm) {
      throw conflict(
        `Template '${template.name}' is ready: seeding replaces its sign-ins; confirm with confirm=true.`,
      );
    }
    const state = toState(input);
    return await this.#start(template, 'seed', options.by, {
      audit: {
        action: 'template.seed',
        details: { cookies: state.cookies.length, origins: state.origins.length },
      },
      run: async (token) => {
        const closed = await this.#deps.ops.drainForOperation(template, true);
        const version = await this.#apply(template, state, token, {
          reason: 'import',
          by: options.by,
        });
        const current = await this.#deps.repos.templates.get(templateId);
        if (current?.status === 'recording') {
          await this.#deps.repos.templates.update(templateId, { status: 'ready' });
        }
        return { version, closed };
      },
    });
  }

  // --- internals ----------------------------------------------------------------------------------

  async #template(templateId: string): Promise<TemplateRecord> {
    const template = await this.#deps.repos.templates.get(templateId);
    if (template === null) throw notFoundForOperator(templateId);
    return template;
  }

  /** Starts the browser for the holder, applies `state`, writes the version from what it holds. */
  async #apply(
    template: TemplateRecord,
    state: TemplateState,
    token: symbol,
    request: Parameters<TemplateStateService['saveVersion']>[1],
  ): Promise<number | undefined> {
    return await this.#deps.ops.withHost(
      template,
      async (host) => {
        await host.setStorageState(state);
        const version = await this.#deps.state.saveVersion(template.templateId, request);
        return version ?? undefined;
      },
      token,
    );
  }

  async #start(
    template: TemplateRecord,
    kind: TemplateOperation['kind'],
    by: string,
    work: {
      readonly audit: { readonly action: string; readonly details: JsonObject };
      readonly run: (
        token: symbol,
      ) => Promise<{ version: number | undefined; closed: readonly string[] }>;
    },
  ): Promise<{ readonly operation_id: string }> {
    const hold = this.#deps.ops.hold(template.templateId);
    if (hold === null) throw busy();
    const now = this.#deps.clock.now();
    const op: TemplateOperation = {
      operation_id: `op-${this.#deps.ids.opaque(12)}`,
      kind,
      state: 'running',
      template_id: template.templateId,
      closed_sessions: [],
      started_at: now,
      finished_at: null,
    };
    this.#put(op);
    try {
      await this.#deps.repos.operatorActions.append({
        eventId: this.#deps.ids.eventId(),
        principalId: by,
        action: work.audit.action,
        resourceKind: 'template',
        resourceId: template.templateId,
        details: { ...work.audit.details, operation_id: op.operation_id },
        occurredAt: now,
      });
    } catch (err) {
      hold.release();
      this.#operations.delete(op.operation_id);
      throw err;
    }
    this.#log.info('template operation started', {
      templateId: template.templateId,
      kind,
      operationId: op.operation_id,
    });
    void work
      .run(hold.token)
      .then(
        ({ version, closed }) =>
          this.#put({
            ...op,
            state: 'done',
            ...(version !== undefined && { version }),
            closed_sessions: [...closed],
            finished_at: this.#deps.clock.now(),
          }),
        (err: unknown) => {
          this.#log.warn('template operation failed', {
            templateId: template.templateId,
            kind,
            err: serializeError(err),
          });
          const error = isAppError(err)
            ? { code: err.code, message: serializeError(err).message }
            : { code: 'INTERNAL_ERROR', message: 'The operation failed; see the server log.' };
          this.#put({ ...op, state: 'failed', error, finished_at: this.#deps.clock.now() });
        },
      )
      .finally(() => {
        hold.release();
        this.#deps.changed?.(template.templateId);
      });
    return { operation_id: op.operation_id };
  }

  #put(op: TemplateOperation): void {
    this.#operations.delete(op.operation_id);
    this.#operations.set(op.operation_id, op);
    while (this.#operations.size > MAX_OPERATIONS) {
      const finished = [...this.#operations.values()].find((o) => o.state !== 'running');
      if (finished === undefined) break;
      this.#operations.delete(finished.operation_id);
    }
    this.#deps.bus?.publish('template.operation', {
      type: 'template.operation',
      operation_id: op.operation_id,
      kind: op.kind,
      state: op.state,
      template_id: op.template_id,
      ...(op.version !== undefined && { version: op.version }),
      ...(op.error !== undefined && { error: op.error }),
    });
  }
}

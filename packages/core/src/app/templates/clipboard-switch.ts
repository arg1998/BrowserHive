/** @module app/templates/clipboard-switch — the "Deny clipboard writes" switch reaching a running template browser (spec 13 §2.1, D18): applied live when an operator changes it, no restart; applied again once a starting browser runs, so a change that landed while it started is not lost (review #84 M1); a browser that cannot take it live is restarted, so its start applies it. */

import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { EventBus } from '../../ports/event-bus.ts';
import type { Logger } from '../../ports/logger.ts';
import type { TemplateRecord, TemplateRepository } from '../../ports/persistence/index.ts';
import type { TemplateHostOps, TemplateRuntime } from '../../ports/template-runtime.ts';
import type { DomainEvents } from '../events/catalog.ts';

/**
 * Applies the switch to the template's running browser; a no-op when it is not running (the next
 * start reads the template) or already in that state. Wired by the composition over the host
 * supervisor.
 */
export type ClipboardWrites = (templateId: string, deny: boolean) => Promise<void>;

/** The service option that carries the live path (`TemplateEditDeps` extends it). */
export interface ClipboardSwitchOption {
  /** "Deny clipboard writes" on a running browser (D18); absent = applied at the next start only. */
  readonly clipboardWrites?: ClipboardWrites | undefined;
}

/** Collaborators of {@link applyClipboardSwitch}. */
export interface ClipboardSwitchDeps extends ClipboardSwitchOption {
  readonly runtime: Pick<TemplateRuntime, 'host'>;
  readonly ops: Pick<TemplateHostOps, 'restartHost'>;
  readonly logger: Logger;
}

/** After the switch changed in the database: apply it live; never throws. */
export async function applyClipboardSwitch(
  deps: ClipboardSwitchDeps,
  template: TemplateRecord,
): Promise<void> {
  const apply = deps.clipboardWrites;
  if (apply === undefined) return;
  try {
    await apply(template.templateId, template.denyClipboardWrites);
  } catch (err) {
    deps.logger.warn('clipboard not applied live', {
      templateId: template.templateId,
      err: serializeError(err),
    });
    if (deps.runtime.host(template.templateId).state !== 'running') return;
    await deps.ops
      .restartHost(template)
      .catch((cause: unknown) =>
        deps.logger.warn('host not restarted', { err: serializeError(cause) }),
      );
  }
}

/** Collaborators of {@link watchClipboardOnStart}. */
export interface ClipboardStartDeps extends ClipboardSwitchDeps {
  readonly templates: Pick<TemplateRepository, 'get'>;
  readonly bus: Pick<EventBus<DomainEvents>, 'subscribe'>;
}

/**
 * How many times one host start re-reads the template: a `PATCH` racing the re-read is applied by
 * its own live call or by the next round; two rounds settle any single change.
 */
const START_ROUNDS = 3;

/**
 * When a template's browser reaches `running`, applies the switch as the template has it now.
 * The start built its spec from the template before the browser ran, and a `PATCH` meanwhile found
 * no running browser to reach, so without this the switch would stay off (or on) until some later
 * start (review #84 M1). Applying the value the browser already has does nothing. The template is
 * read again after each apply until it no longer changes, so a `PATCH` committed between the read
 * and the apply cannot leave the older value in force. Returns the unsubscribe.
 */
export function watchClipboardOnStart(deps: ClipboardStartDeps): () => void {
  const reconcile = async (templateId: string): Promise<void> => {
    let applied: boolean | null = null;
    for (let round = 0; round < START_ROUNDS; round++) {
      const template = await deps.templates.get(templateId);
      if (template === null || template.denyClipboardWrites === applied) return;
      await applyClipboardSwitch(deps, template);
      applied = template.denyClipboardWrites;
    }
  };
  return deps.bus.subscribe('template.host', ({ payload }) => {
    if (payload.host.state !== 'running' || payload.previous_state === 'running') return;
    void reconcile(payload.template_id).catch((err: unknown) =>
      deps.logger.warn('clipboard not reconciled', {
        templateId: payload.template_id,
        err: serializeError(err),
      }),
    );
  });
}

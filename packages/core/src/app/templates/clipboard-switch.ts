/** @module app/templates/clipboard-switch — the "Deny clipboard writes" switch reaching a running template browser when an operator changes it (spec 13 §2.1, D18): applied live, no restart; a browser that cannot take it live is restarted, so its start applies it. */

import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Logger } from '../../ports/logger.ts';
import type { TemplateRecord } from '../../ports/persistence/index.ts';
import type { TemplateHostOps, TemplateRuntime } from '../../ports/template-runtime.ts';

/**
 * Applies the switch to the template's running browser; a no-op when it is not running (the next
 * start reads the template). Wired by the composition over the host supervisor.
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

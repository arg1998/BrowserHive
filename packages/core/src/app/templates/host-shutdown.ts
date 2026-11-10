/** @module app/templates/host-shutdown — the daemon shutdown of every template host (spec 13 §3.2; PR #76 F12) and the identity a host start observes (spec 13 §2.2: recorded at the first start, compared at later ones). */

import type { ClosedReason } from '@browserhive/contracts/enums';
import { settlesWithin } from '../../kernel/deadline.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Clock } from '../../ports/clock.ts';
import type { Logger } from '../../ports/logger.ts';
import type { TemplateRecord, TemplateRepository } from '../../ports/persistence/index.ts';
import type { TemplateHost } from '../../ports/template-host.ts';
import type { HostLifecycle } from './host-lifecycle.ts';
import { observeStart } from './host-spec.ts';

/** One host to stop and the sessions it had when the shutdown began. */
export interface HostStop {
  readonly lifecycle: HostLifecycle;
  readonly sessions: readonly string[];
}

/**
 * Stops every host (`shutdown`: final checkpoint, then the browser) and closes the sessions it had,
 * within `deadlineMs` when given: a stop that overruns is logged and left to finish, and never
 * closes a session that started after the shutdown began.
 */
export async function stopHosts(
  stops: readonly HostStop[],
  closeSessions: (ids: readonly string[], reason: ClosedReason) => Promise<void>,
  clock: Clock,
  log: Logger,
  deadlineMs?: number,
): Promise<void> {
  const stopping = Promise.allSettled(
    stops.map(async ({ lifecycle, sessions }) => {
      await lifecycle.stop('shutdown');
      await closeSessions(sessions, 'shutdown');
    }),
  );
  const sleep = (ms: number, signal?: AbortSignal) => clock.sleep(ms, signal);
  if (deadlineMs === undefined) await stopping;
  else if (!(await settlesWithin(stopping, sleep, deadlineMs))) {
    log.warn('hosts closing past budget', { deadlineMs });
  }
}

/** A Chrome major that differs from the one recorded at the first start (spec 13 §2.2). */
export interface IdentityDrift {
  readonly from: string;
  readonly to: string;
}

/** Collaborators of {@link IdentityObserver}. */
export interface IdentityObserverDeps {
  readonly templates: Pick<TemplateRepository, 'update'>;
  readonly clock: Clock;
  readonly log: Logger;
  /** The row was updated (refresh the lifecycle) or the drift changed (`template.changed`). */
  readonly changed: (template: TemplateRecord | null, templateId: string) => void;
}

/** Records the observed identity at a template's first start and tracks drift at later ones. */
export class IdentityObserver {
  readonly #drift = new Map<string, IdentityDrift>();
  readonly #deps: IdentityObserverDeps;

  constructor(deps: IdentityObserverDeps) {
    this.#deps = deps;
  }

  /** The drift of a template's host since its creation, if its last start saw one. */
  drift(templateId: string): IdentityDrift | undefined {
    return this.#drift.get(templateId);
  }

  /** A host came up. */
  started(template: TemplateRecord, host: TemplateHost): void {
    const id = template.templateId;
    const seen = observeStart(template, host, this.#deps.clock.now());
    if (seen?.kind === 'drift') {
      this.#deps.log.warn('identity drift', { templateId: id, from: seen.from, to: seen.to });
      this.#drift.set(id, { from: seen.from, to: seen.to });
      this.#deps.changed(null, id);
      return;
    }
    if (this.#drift.delete(id)) this.#deps.changed(null, id);
    if (seen?.kind !== 'record') return;
    this.#deps.templates.update(id, { identityObserved: seen.record }).then(
      (updated) => this.#deps.changed(updated, id),
      (err: unknown) =>
        this.#deps.log.warn('observed identity unsaved', { err: serializeError(err) }),
    );
  }
}

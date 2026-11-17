/** @module app/templates/host-events — the supervisor's bookkeeping kept out of it (spec 13 §3.2, §6.3, §8.6): `template.host` with the template's names and the state it left (the host notifications), and the launches admitted and not finished (the cap counts them). */

import type { HostView } from '@browserhive/contracts/http';
import type { Session } from '../../domain/session/session.ts';
import { withDeadline } from '../../kernel/deadline.ts';
import type { EventPublisher } from '../../ports/event-bus.ts';
import type { TemplateRecord } from '../../ports/persistence/index.ts';
import type { TemplateHost } from '../../ports/template-host.ts';
import type { DomainEvents, TemplateNames } from '../events/catalog.ts';
import { TEMPLATE_LAUNCH_BUDGET_MS } from './host-state.ts';

/** Publishes `template.host`, remembering what the notifications need. */
export class HostEvents {
  readonly #names = new Map<string, TemplateNames>();
  readonly #published = new Map<string, HostView['state']>();
  readonly #bus: EventPublisher<DomainEvents> | undefined;
  readonly #view: (templateId: string) => HostView;

  constructor(
    bus: EventPublisher<DomainEvents> | undefined,
    view: (templateId: string) => HostView,
  ) {
    this.#bus = bus;
    this.#view = view;
  }

  /** The template's current names (every lifecycle access refreshes them). */
  remember(template: TemplateRecord): void {
    this.#names.set(template.templateId, {
      name: template.name,
      display_name: template.displayName,
    });
  }

  /** `template.host` on the `templates` topic, with the state the host left. */
  publish(templateId: string): void {
    const host = this.#view(templateId);
    const previous = this.#published.get(templateId);
    this.#published.set(templateId, host.state);
    const names = this.#names.get(templateId);
    this.#bus?.publish('template.host', {
      type: 'template.host',
      template_id: templateId,
      host,
      ...(names !== undefined && { names }),
      ...(previous !== undefined && { previous_state: previous }),
    });
  }
}

/** Launches admitted and not finished, per template. */
export class PendingLaunches {
  readonly #pending = new Map<string, number>();

  count(templateId: string): number {
    return this.#pending.get(templateId) ?? 0;
  }

  /** Runs one launch within the 50 s budget (spec 13 §3.7), counted while it runs. */
  async run(
    templateId: string,
    launch: (budget: AbortSignal) => Promise<Session>,
    signal?: AbortSignal,
    budgetMs: number = TEMPLATE_LAUNCH_BUDGET_MS,
  ): Promise<Session> {
    const budget = withDeadline(signal, Math.max(1, budgetMs));
    this.#pending.set(templateId, this.count(templateId) + 1);
    try {
      return await launch(budget.signal);
    } finally {
      this.#pending.set(templateId, Math.max(0, this.count(templateId) - 1));
      budget.clear();
    }
  }
}

/** The resident memory of a host's process tree (spec 13 §3.2), or `null` when it cannot be read. */
export async function sampleRss(
  rssOf: ((pid: number) => Promise<number | null>) | undefined,
  host: TemplateHost,
): Promise<number | null> {
  if (rssOf === undefined || host.browserPid === undefined) return null;
  const pid = await host.browserPid();
  return pid === null ? null : await rssOf(pid);
}

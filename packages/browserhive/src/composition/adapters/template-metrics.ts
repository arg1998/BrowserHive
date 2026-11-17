/** @module composition/adapters/template-metrics — the template instruments of spec 13 §11.7 (spec 10 §7): `browserhive.template.hosts` (hosts per state at each export), `browserhive.template.probes` (one per `template.probe`), `browserhive.template.relogins` (one per finished re-login, from `template.relogin`) and `browserhive.site_pack.challenges` (one per `site_pack.challenge`). */

import type { DomainEvents, EventBus, Instruments } from '@browserhive/core/runtime';

/** The states the hosts gauge reports, each at every export (0 included); `stopped` is not a host. */
export const TEMPLATE_HOST_STATES = [
  'starting',
  'running',
  'draining',
  'crashed',
  'failed',
] as const;

/** Re-logins remembered for the de-duplication of their final event (oldest forgotten first). */
const SEEN_RELOGINS_MAX = 1_024;

/** A re-login's final state and the `outcome` attribute it is counted with; others are not counted. */
const RELOGIN_OUTCOME: Readonly<Record<string, 'signed_in' | 'failed' | 'timeout'>> = {
  signed_in: 'signed_in',
  failed: 'failed',
  timed_out: 'timeout',
};

interface Observer {
  observe(value: number, attributes?: Record<string, string>): void;
}

/** Hosts per reported state, from every host's state (`stopped` and unknown states left out). */
export function hostsByState(states: Iterable<string>): Map<string, number> {
  const counts = new Map<string, number>(TEMPLATE_HOST_STATES.map((s) => [s, 0]));
  for (const state of states) {
    const n = counts.get(state);
    if (n !== undefined) counts.set(state, n + 1);
  }
  return counts;
}

/** The hosts gauge's callback over the supervisor's states (`undefined` = templates off: no points). */
export function templateHostsCallback(
  states: (() => Iterable<string>) | undefined,
): (result: Observer) => void {
  return (result) => {
    if (states === undefined) return;
    for (const [state, count] of hostsByState(states())) result.observe(count, { state });
  };
}

/**
 * Counts a re-login once when its event first reaches a final state (`signed_in`, `failed`,
 * `timed_out` → `timeout`; `cancelled` is not a finished re-login of the catalogue). The same
 * re-login (template, site, request time) published again is not counted again.
 */
export function reloginOutcomes(): (
  event: DomainEvents['template.relogin'],
) => { readonly method: string; readonly outcome: string } | null {
  const seen = new Set<string>();
  return (event) => {
    const relogin = event.relogin;
    const outcome = RELOGIN_OUTCOME[relogin.state];
    if (outcome === undefined) return null;
    const key = `${event.template_id}\u0000${relogin.site_id}\u0000${relogin.requested_at}`;
    if (seen.has(key)) return null;
    seen.add(key);
    if (seen.size > SEEN_RELOGINS_MAX) {
      const oldest = seen.values().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    return { method: relogin.method, outcome };
  };
}

/** Subscribes the probe and re-login counters; returns their unsubscribers. */
export function subscribeTemplateMetrics(
  instruments: Instruments,
  bus: EventBus<DomainEvents>,
): (() => void)[] {
  const finished = reloginOutcomes();
  return [
    bus.subscribe('template.probe', ({ payload }) =>
      instruments.templateProbes.add(1, {
        outcome: payload.probe.outcome,
        trigger: payload.probe.trigger,
      }),
    ),
    bus.subscribe('template.relogin', ({ payload }) => {
      const counted = finished(payload);
      if (counted !== null) instruments.templateRelogins.add(1, counted);
    }),
    // One per detected challenge (spec 13 §11.7).
    bus.subscribe('site_pack.challenge', ({ payload }) =>
      instruments.sitePackChallenges.add(1, { kind: payload.kind, action: payload.action }),
    ),
  ];
}

/** @module test/helpers/fake-probe-hosts — a scriptable `ProbeHosts` for the template health suites (spec 13 §8.1, §8.3): running browsers per template, a free-slot switch, and the `withHost` starts it was asked for. */

import type { ProbeHosts } from '../../src/app/templates/template-health.ts';
import type { TemplateRecord } from '../../src/ports/persistence/index.ts';
import type { TemplateHost } from '../../src/ports/template-host.ts';
import { FakeTemplateHost } from './fake-template-host.ts';

/** Browsers the probes may use; a `withHost` start runs `fn` on {@link started} (made on demand). */
export class FakeProbeHosts implements ProbeHosts {
  readonly running = new Map<string, TemplateHost>();
  /** Hosts `withHost` started, per template. */
  readonly started = new Map<string, FakeTemplateHost>();
  /** Template ids `withHost` was called for, in order. */
  readonly starts: string[] = [];
  free = true;
  /** When set, `withHost` fails with it (a start refusal). */
  failStart: Error | null = null;

  runningHost(templateId: string): TemplateHost | null {
    return this.running.get(templateId) ?? null;
  }

  async withHost<T>(template: TemplateRecord, fn: (host: TemplateHost) => Promise<T>): Promise<T> {
    this.starts.push(template.templateId);
    if (this.failStart !== null) throw this.failStart;
    const host = this.started.get(template.templateId) ?? new FakeTemplateHost(template.templateId);
    this.started.set(template.templateId, host);
    return fn(host);
  }

  slotFree(): boolean {
    return this.free;
  }
}

/** Resolves once `cond` holds, letting queued continuations run; fails after many turns. */
export async function until(cond: () => boolean, turns = 2_000): Promise<void> {
  for (let i = 0; i < turns; i++) {
    if (cond()) return;
    await Promise.resolve();
  }
  throw new Error('condition never held');
}

/** A promise with its resolver exposed. */
export function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

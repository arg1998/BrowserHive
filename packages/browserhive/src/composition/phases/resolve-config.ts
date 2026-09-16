/** @module composition/phases/resolve-config — phase 1: the config arrives resolved; this phase asserts it is frozen and emits the startup diagnostics once a logger exists. */

import type { ResolvedConfigBundle } from '@browserhive/core/config';
import type { Logger } from '@browserhive/core/runtime';
import type { BootContext } from '../context.ts';
import type { PhaseHandle } from '../unwind.ts';

/** Deep-freezes a value in place (the resolver already freezes; this makes the invariant local). */
export function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/** Phase `resolve-config`: nothing to open, nothing to stop. */
export async function resolveConfigPhase(ctx: BootContext): Promise<PhaseHandle> {
  ctx.health.enter('resolve-config');
  deepFreeze(ctx.input.resolved.config);
  return { stop: async () => undefined };
}

/**
 * Logs the shadow lines (spec 08 §1: one `info` line per key supplied by several sources) and the
 * resolver's warnings. Called by the observability phase right after the logger is built.
 */
export function logConfigDiagnostics(logger: Logger, resolved: ResolvedConfigBundle): void {
  const log = logger.child({ module: 'config' });
  for (const line of resolved.diagnostics.shadowLines) log.info(line.text, { key: line.key });
  for (const warning of resolved.diagnostics.warnings) log.warn(warning);
}

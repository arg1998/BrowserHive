/** @module infra/browsers/preflight-enforcement — whether this process enforces real CORS preflights in routed contexts (D-66): the verified driver version, the process-wide state shared by every copy of the module, and the listeners told when enforcement is refused. */

import { createRequire } from 'node:module';
import { z } from 'zod';

/**
 * The driver versions whose internals the preflight hook was verified against
 * (`driver-preflights.ts`). Any other version is refused before the hook is armed: routed
 * contexts then refuse cross-origin requests that need a preflight instead of letting the driver
 * answer them (fail closed). A Patchright bump adds its version here only after
 * `test/integration/cors-preflights.test.ts` passes on it; `preflight-enforcement.test.ts` fails
 * while the installed version is missing.
 */
export const VERIFIED_DRIVER_VERSIONS: readonly string[] = Object.freeze(['1.63.0']);

/** Whether `version` (of `patchright-core`) is one the preflight hook was verified against. */
export function isVerifiedDriverVersion(version: string | null): boolean {
  return version !== null && VERIFIED_DRIVER_VERSIONS.includes(version);
}

/**
 * - `pending`: no routed context has armed the hook yet (nothing to enforce, nothing refused).
 * - `enforced`: the driver's preflight code is wrapped and verified.
 * - `refused`: it cannot be (see {@link PreflightRefusal}); routed contexts fail closed.
 */
export type PreflightEnforcementState = 'pending' | 'enforced' | 'refused';

/**
 * Why enforcement was refused:
 * - `driver_version`: `patchright-core` is not in {@link VERIFIED_DRIVER_VERSIONS};
 * - `driver_shape`: the driver's network manager, or its preflight branch, is not as verified;
 * - `driver_connection`: a context without the in-process driver connection;
 * - `unexpected_preflight`: a paused preflight whose shape the hook could not read.
 */
export type PreflightRefusal =
  | 'driver_version'
  | 'driver_shape'
  | 'driver_connection'
  | 'unexpected_preflight';

/** The process's enforcement, as `/system` and the degradation report state it. */
export interface PreflightEnforcement {
  readonly state: PreflightEnforcementState;
  readonly reason: PreflightRefusal | null;
  /** The installed `patchright-core` version, or `null` when it cannot be read. */
  readonly driverVersion: string | null;
}

/** Told once, when enforcement is first refused. */
export type PreflightRefusalListener = (enforcement: PreflightEnforcement) => void;

interface SharedState {
  state: PreflightEnforcementState;
  reason: PreflightRefusal | null;
  /** Server-side browser contexts with a hook, shared by every copy of this module (F6). */
  readonly hooks: WeakMap<object, unknown>;
  readonly listeners: Set<PreflightRefusalListener>;
}

const SHARED_KEY = Symbol.for('browserhive.preflightEnforcement');

/**
 * The one state of the process. Kept on `globalThis` under a registered symbol, so two copies of
 * this module (a bundled CLI beside a direct `@browserhive/core` import) see the same hooks and
 * the same state: the wrapper one copy installs consults the hooks the other registers.
 */
export function sharedPreflightState(): SharedState {
  const existing: unknown = Reflect.get(globalThis, SHARED_KEY);
  if (isSharedState(existing)) return existing;
  const created: SharedState = {
    state: 'pending',
    reason: null,
    hooks: new WeakMap(),
    listeners: new Set(),
  };
  Object.defineProperty(globalThis, SHARED_KEY, { value: created, configurable: true });
  return created;
}

function isSharedState(value: unknown): value is SharedState {
  return (
    typeof value === 'object' &&
    value !== null &&
    'hooks' in value &&
    value.hooks instanceof WeakMap &&
    'listeners' in value &&
    value.listeners instanceof Set
  );
}

const PackageVersion = z.object({ version: z.string() });
let coreVersion: string | null | undefined;

/** The installed `patchright-core` version (read once, through `patchright`'s own resolution). */
export function driverCoreVersion(): string | null {
  if (coreVersion !== undefined) return coreVersion;
  try {
    const fromHere = createRequire(import.meta.url);
    const fromPatchright = createRequire(fromHere.resolve('patchright/package.json'));
    coreVersion = PackageVersion.parse(fromPatchright('patchright-core/package.json')).version;
  } catch {
    coreVersion = null;
  }
  return coreVersion;
}

/** The process's enforcement now. */
export function preflightEnforcement(): PreflightEnforcement {
  const shared = sharedPreflightState();
  return { state: shared.state, reason: shared.reason, driverVersion: driverCoreVersion() };
}

/**
 * Checks the driver version before anything is wrapped; refuses enforcement when it is not
 * verified. Called at boot (so the degradation shows before the first routed session) and before
 * every wrap.
 */
export function verifyPreflightDriver(): PreflightEnforcement {
  if (!isVerifiedDriverVersion(driverCoreVersion())) refusePreflights('driver_version');
  return preflightEnforcement();
}

/** Marks enforcement refused (sticky) and tells the listeners, once. */
export function refusePreflights(reason: PreflightRefusal): void {
  const shared = sharedPreflightState();
  if (shared.state === 'refused') return;
  shared.state = 'refused';
  shared.reason = reason;
  const enforcement = preflightEnforcement();
  for (const listener of shared.listeners) {
    try {
      listener(enforcement);
    } catch {
      // A listener never stops the others.
    }
  }
}

/** Marks enforcement in force, unless it was refused. */
export function markPreflightsEnforced(): void {
  const shared = sharedPreflightState();
  if (shared.state === 'pending') shared.state = 'enforced';
}

/**
 * Calls `listener` when enforcement is refused, at once when it already is.
 *
 * @returns Removes the listener.
 */
export function onPreflightRefusal(listener: PreflightRefusalListener): () => void {
  const shared = sharedPreflightState();
  shared.listeners.add(listener);
  if (shared.state === 'refused') listener(preflightEnforcement());
  return () => {
    shared.listeners.delete(listener);
  };
}

/** @internal Tests only: back to `pending`, no hooks, no listeners; the version is read again. */
export function resetPreflightEnforcementForTests(): void {
  Reflect.deleteProperty(globalThis, SHARED_KEY);
  coreVersion = undefined;
}

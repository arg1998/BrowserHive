/** @module composition/boot — `bootServer`: runs the named phases on an unwind stack; failure in phase N unwinds N-1…1 and rethrows the typed boot error; `stop()` unwinds within the shutdown budgets (spec 01 §6). */
import type { Clock } from '@browserhive/core/runtime';
import { AppError } from '@browserhive/core/runtime';
import type { BootContext } from './context.ts';
import { type ServeFn } from './phases/listeners-http.ts';
import { type SignalTarget } from './process-handlers.ts';
import type { BootInput, RunningServer } from './types.ts';
import { type PhaseHandle } from './unwind.ts';
/** Phase names in boot order. */
export type PhaseName =
  | 'resolve-config'
  | 'observability'
  | 'open-storage'
  | 'build-domain'
  | 'wire-observers'
  | 'open-listeners'
  | 'ready';
/** One composition phase. `budgetMs` caps its `stop` during shutdown. */
export interface PhaseDefinition {
  readonly name: PhaseName;
  readonly budgetMs: number;
  run(ctx: BootContext): Promise<PhaseHandle>;
}
/** Shutdown budgets (spec 01 §6): listeners 2 s, sessions drain 15 s, storage flush 5 s. */
export declare const STOP_BUDGETS: Readonly<Record<PhaseName, number>>;
/** The production phase list. */
export declare function defaultPhases(serve?: ServeFn): readonly PhaseDefinition[];
/** Test and embedding seams of {@link bootServer}. */
export interface BootOverrides {
  readonly clock?: Clock;
  /** Replaces `Bun.serve` (bind failure tests). */
  readonly serve?: ServeFn;
  /** Replaces the phase list (phase-order and unwind tests). */
  readonly phases?: (defaults: readonly PhaseDefinition[]) => readonly PhaseDefinition[];
  /** Where process handlers attach (default `process`). */
  readonly signals?: SignalTarget;
  /** Immediate exit for the forced-stop path (default `process.exit`). */
  readonly exit?: (code: number) => void;
}
/** Wraps anything that is not an `AppError` as `INTERNAL_ERROR { ref: 'boot' }`. */
export declare function toBootError(err: unknown): AppError;
/**
 * Boots the server. Resolves once the `ready` phase completed (listener bound, banner printed).
 *
 * @throws `AppError` with a boot code (`PORT_IN_USE`, `BIND_FAILED`, `DATA_DIR_LOCKED`,
 * `DB_NEWER_THAN_BINARY`, `MIGRATION_FAILED`, `BLOCKLIST_LOAD_FAILED`, …); earlier phases are unwound.
 */
export declare function bootServer(
  input: BootInput,
  overrides?: BootOverrides,
): Promise<RunningServer>;
//# sourceMappingURL=boot.d.ts.map

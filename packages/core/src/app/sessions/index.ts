/** @module app/sessions — public surface of the session subsystem. */

export {
  type CreateOptions,
  type CreateOutcome,
  type PhaseTiming,
  PIPELINE_PHASES,
  type PipelinePhase,
} from './create-pipeline.ts';
export type { LeaseController } from './lease-controller.ts';
export {
  DEFAULT_SWEEP_INTERVAL_MS,
  LeaseSweeper,
  type LeaseSweeperDeps,
  type Reaped,
  type SweepScheduler,
  type SweepTarget,
} from './lease-sweeper.ts';
export {
  configJson,
  type SessionMetadataWithDriver,
  safeCurrentUrl,
  toSessionMetadata,
  toSessionPatch,
  toSessionRecord,
  toSessionSummary,
} from './metadata.ts';
export {
  cleanupAfterClose,
  createNodeSessionDirFs,
  DIR_MODE,
  prepareSessionDirs,
  removeSessionDir,
  SESSIONS_DIR_NAME,
  type SessionDirFs,
  type SessionDirLayout,
  type SessionDirs,
  sessionDirLayout,
} from './profile-dir.ts';
export { SessionRegistry } from './registry.ts';
export type {
  SessionServerStatus,
  SessionServiceConfig,
  SessionServiceDeps,
} from './service-deps.ts';
export type { CloseOptions } from './session-close.ts';
export { SessionPublisher, type SessionPublisherDeps } from './session-publisher.ts';
export { DEFAULT_CREATE_DEADLINE_MS, SessionService } from './session-service.ts';
export type { TabInfo } from './session-tabs.ts';

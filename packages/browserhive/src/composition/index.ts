/** @module composition — the seam between the composition root, the CLI (`src/cli/**`) and the programmatic API (`src/index.ts`). */

export { type AuthStack, createAuthStack, GRANT_REUSE_WINDOW_MS } from './auth-stack.ts';
export { type BannerFacts, renderBanner } from './banner.ts';
export {
  type BootOverrides,
  bootServer,
  defaultPhases,
  type PhaseDefinition,
  type PhaseName,
  STOP_BUDGETS,
  toBootError,
} from './boot.ts';
export { type CliStorage, type CliStorageOptions, openStorageForCli } from './cli-storage.ts';
export { nodeConfigFs } from './config-fs.ts';
export { resolveDashboardDir } from './dashboard-dir.ts';
export { DATA_DIR_MODE, DATA_SUBDIRS, dataDirLayout, ensureDataDir } from './data-dir.ts';
export {
  buildHostEnvironment,
  type HostFacts,
  hostFactsOf,
  LOG_MODULES,
  type ProcessFacts,
  processEnv,
} from './host.ts';
export {
  acquireDataDirLock,
  type DataDirLock,
  LOCK_FILE_NAME,
  type LockInfo,
  lockPathFor,
  type PidProbe,
  processPidProbe,
  readLiveLock,
  readLock,
} from './lock-file.ts';
export {
  FORCED_EXIT_CODE,
  installProcessHandlers,
  isStorageCorruption,
  type ProcessHandlerDeps,
  type SignalTarget,
} from './process-handlers.ts';
export {
  type BootInput,
  type OutputSinks,
  processOutput,
  type RunningServer,
} from './types.ts';

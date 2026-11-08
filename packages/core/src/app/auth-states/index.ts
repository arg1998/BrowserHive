/** @module app/auth-states — public surface of the saved-auth-state store. */

export {
  AUTH_DIR_MODE,
  AUTH_FILE_MODE,
  AUTH_STATES_DIR_NAME,
  AuthManifest,
  type AuthStateChangedEvent,
  type AuthStateEvents,
  type AuthStateFiles,
  type AuthStateFs,
  type AuthStateRecord,
  AuthStateStore,
  type AuthStateStoreDeps,
  assertValidAuthName,
  authStateNotFound,
  createNodeAuthStateFs,
  DEFAULT_OWNER,
  PRINCIPAL_DIRS_NAME,
  principalDirName,
  type SavedAuthEntry,
  type SavedAuthResult,
  type StorageStateSource,
} from './store.ts';
export { type DirEntry, unzipToDirectory, ZIP_LEVEL, type ZipFs, zipDirectory } from './zip.ts';

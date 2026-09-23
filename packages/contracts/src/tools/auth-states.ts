/** @module contracts/tools/auth-states — save_storage_state, save_full_profile, list_saved_auths contracts */
import { z } from 'zod';
import { SavedAuthKind } from '../enums/saved-auth-kind.ts';
import { annotations, SESSION_ERRORS, SINCE } from './shared.ts';
import { defineTool } from './types.ts';

/** Auth-state name rule (server-side; violation ⇒ `PATH_NOT_ALLOWED`). Must also not contain `..`. */
export const AUTH_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Result of both save tools: the snapshot name, its absolute path and byte size. */
export const SavedAuthResult = z.object({ name: z.string(), path: z.string(), size: z.number() });

/** One `list_saved_auths` row (manifest projection). */
export const SavedAuthEntry = z.object({
  name: z.string(),
  kind: SavedAuthKind,
  saved_at: z.number(),
  size: z.number(),
});

/** `save_storage_state`: light cookies, localStorage and IndexedDB snapshot; valid in any persistence mode. */
export const SAVE_STORAGE_STATE = defineTool({
  name: 'save_storage_state',
  title: 'Save storage state',
  description:
    'Save the session\'s cookies, localStorage and IndexedDB as a light "storage-state" snapshot for later ' +
    'restore via launch_session({ context_options: { storageState: name } }) in a non-persistent ' +
    'mode. Valid in any persistence mode.',
  input: z.object({ session_id: z.string(), name: z.string() }),
  output: SavedAuthResult,
  annotations: annotations(false, false, true, false),
  pack: 'authStates',
  capability: 'mutate',
  errors: [...SESSION_ERRORS, 'PATH_NOT_ALLOWED'],
  since: SINCE,
});

/** `save_full_profile`: zipped managed profile; persistent sessions only. */
export const SAVE_FULL_PROFILE = defineTool({
  name: 'save_full_profile',
  title: 'Save full profile',
  description:
    'Save the session\'s full on-disk Chromium profile as a heavy "profile" snapshot (zipped ' +
    'user-data-dir) for later restore via launch_session({ persistence_mode: "persistent", ' +
    'restore_profile: name }). Only valid when the source session is in persistent mode.',
  input: z.object({ session_id: z.string(), name: z.string() }),
  output: SavedAuthResult,
  annotations: annotations(false, false, true, false),
  pack: 'authStates',
  capability: 'mutate',
  errors: [...SESSION_ERRORS, 'INVALID_PERSISTENCE_CONFIG', 'PATH_NOT_ALLOWED'],
  since: SINCE,
});

/** `list_saved_auths`: takes no arguments, so no `inputSchema`; newest first; scoped to the caller. */
export const LIST_SAVED_AUTHS = defineTool({
  name: 'list_saved_auths',
  title: 'List saved auths',
  description:
    'List every saved auth snapshot (storage-state and full-profile) with kind, size, and when ' +
    'it was saved, most recent first.',
  output: z.array(SavedAuthEntry),
  annotations: annotations(true, false, true, false),
  pack: 'authStates',
  capability: 'read',
  errors: [],
  since: SINCE,
});

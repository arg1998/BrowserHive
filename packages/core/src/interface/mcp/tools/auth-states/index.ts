/** @module interface/mcp/tools/auth-states — save_storage_state, save_full_profile, list_saved_auths (restore is part of launch_session). */

import { sessionDirLayout } from '../../../../app/sessions/profile-dir.ts';
import { AppError } from '../../../../kernel/errors/app-error.ts';
import { requireSession } from '../../context.ts';
import { defineTool, json, type ToolPack } from '../../definition.ts';
import { sessionOwnership } from '../../policies.ts';

/** `save_storage_state`: cookies + localStorage snapshot (0600 file + manifest). */
export const saveStorageState = defineTool('save_storage_state', {
  policies: [sessionOwnership],
  async handler(ctx, args) {
    const session = requireSession(ctx);
    const handle = session.handle;
    if (handle === null) {
      throw new AppError(
        'SESSION_NOT_LIVE',
        { session_id: session.id },
        { publicMessage: `Session '${session.id}' is not live.` },
      );
    }
    const saved = await ctx.services.authStates.saveStorageState(
      handle.context,
      args.name,
      session.id,
      ctx.principal,
    );
    return json(saved);
  },
});

/**
 * `save_full_profile`: persistent sessions only; zips the managed `userdata` (regular files) and
 * writes the identity seed sidecar when a fingerprint is presented (best-effort, warned on failure).
 */
export const saveFullProfile = defineTool('save_full_profile', {
  policies: [sessionOwnership],
  async handler(ctx, args) {
    const session = requireSession(ctx);
    if (session.request.persistenceMode !== 'persistent') {
      throw new AppError(
        'INVALID_PERSISTENCE_CONFIG',
        { reason: 'save_full_profile is only valid for a session in persistent mode' },
        {
          publicMessage:
            'Invalid persistence config: save_full_profile is only valid for a session in persistent mode',
        },
      );
    }
    const store = ctx.services.authStates;
    const userdata = sessionDirLayout(ctx.services.runtime.dataDir).forSession(session.id).userdata;
    const saved = await store.saveFullProfile(userdata, args.name, session.id, ctx.principal);
    // The display seed: restored with the profile, else the session id (the resolver's default).
    if (session.request.fingerprint && session.identity?.display != null) {
      const ok = await store.saveIdentitySeed(args.name, session.identitySeed);
      if (!ok) {
        ctx.services.sessions.warn(session, {
          code: 'IDENTITY_SEED_SAVE_FAILED',
          sessionId: session.id,
          message: 'failed to save the identity seed beside the profile snapshot',
          details: { name: args.name },
        });
      }
    }
    return json(saved);
  },
});

/** `list_saved_auths`: the caller's snapshots, newest first (bare array). */
export const listSavedAuths = defineTool('list_saved_auths', {
  policies: [],
  async handler(ctx) {
    return json(await ctx.services.authStates.list(ctx.principal));
  },
});

/** The auth-states pack. */
export const authStatesPack: ToolPack = {
  id: 'authStates',
  tools: [saveStorageState, saveFullProfile, listSavedAuths],
};

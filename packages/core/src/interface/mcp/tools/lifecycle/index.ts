/** @module interface/mcp/tools/lifecycle — launch_session, close_session, list_sessions. */

import { launchSessionInput, type ToolArgs } from '@browserhive/contracts/tools';
import {
  createSessionInputFromWire,
  type LaunchSessionWireArgs,
} from '../../../../domain/session/create-request.ts';
import { defineTool, json, type ToolPack } from '../../definition.ts';
import { drive } from '../shared.ts';

/** Drops `undefined` optionals so the parsed args fit `LaunchSessionWireArgs` exactly. */
function wireArgs(args: ToolArgs<'launch_session'>): LaunchSessionWireArgs {
  return {
    slug: args.slug,
    channel: args.channel,
    incognito: args.incognito,
    headless: args.headless,
    ...(args.persistence_mode !== undefined && { persistence_mode: args.persistence_mode }),
    ...(args.restore_profile !== undefined && { restore_profile: args.restore_profile }),
    ...(args.launch_options !== undefined && { launch_options: args.launch_options }),
    ...(args.context_options !== undefined && { context_options: args.context_options }),
    disable_evaluate: args.disable_evaluate,
    vault_enabled: args.vault_enabled,
    ...(args.stealth !== undefined && { stealth: args.stealth }),
    ...(args.fingerprint !== undefined && { fingerprint: args.fingerprint }),
    ...(args.humanize !== undefined && { humanize: args.humanize }),
  };
}

/** `launch_session`: the schema bakes in `defaultChannel`/`defaultHeadless` (spec 02 §4). */
export const launchSession = defineTool('launch_session', {
  input: (runtime) => launchSessionInput(runtime.launchDefaults),
  policies: [],
  async handler(ctx, args) {
    const sessions = ctx.services.sessions;
    const session = await drive(ctx, {}, () =>
      sessions.create(
        createSessionInputFromWire(wireArgs(args), ctx.connectionId, ctx.client),
        ctx.principal,
        {
          signal: ctx.signal,
        },
      ),
    );
    return json(sessions.metadata(session));
  },
});

/** `close_session`: unknown or foreign ids answer `closed: false` (no existence oracle). */
export const closeSession = defineTool('close_session', {
  policies: [],
  async handler(ctx, args) {
    const closed = await ctx.services.sessions.close(args.session_id, 'user', {
      principal: ctx.principal,
    });
    if (closed) ctx.services.pageActions.forgetSession(args.session_id);
    return json({ session_id: args.session_id, closed });
  },
});

/** `list_sessions`: only the caller's sessions (fix). Bare array result. */
export const listSessions = defineTool('list_sessions', {
  policies: [],
  async handler(ctx) {
    const sessions = ctx.services.sessions;
    return json(sessions.list(ctx.principal).map((s) => sessions.metadata(s)));
  },
});

/** The lifecycle pack. */
export const lifecyclePack: ToolPack = {
  id: 'lifecycle',
  tools: [launchSession, closeSession, listSessions],
};

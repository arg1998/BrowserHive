/** @module cli/commands/serve — `browserhive [serve]`: hands the resolved configuration to the composition root and waits for it to stop (spec 08 §7.1, §7.4) */
import type { ResolvedConfigBundle } from '@browserhive/core/config';
import type { CommandContext } from '../deps.ts';

/**
 * Boots the server and resolves with its exit code once it stopped (signals are handled by the
 * composition root: first SIGINT/SIGTERM graceful, second 130). Under stdio the context's output
 * already routes every line to stderr. Shadow lines and resolver warnings are not printed here: the
 * composition root logs them in `resolve-config` and repeats them in the banner (spec 08 §1, §8).
 *
 * @returns The server's exit code.
 * @throws Boot `AppError`s (`PORT_IN_USE`, `DB_NEWER_THAN_BINARY`, …); the runner maps them.
 */
export async function runServe(
  context: CommandContext,
  resolved: ResolvedConfigBundle,
): Promise<number> {
  const { deps, out } = context;
  const server = await deps.bootServer({
    resolved,
    host: deps.host,
    output: out.sinks(),
    env: deps.env,
    appVersion: deps.appVersion,
    installProcessHandlers: true,
  });
  return server.done;
}

/** @module cli/run — `runCli`: plans argv, builds the output, dispatches the command and maps thrown `AppError`s to their registry exit codes with a rendered message (no stack unless debug logging) */

import {
  runResetPassword,
  runTokensCreate,
  runTokensList,
  runTokensRevoke,
} from './commands/admin.ts';
import { appErrorFacts } from './commands/common.ts';
import { runConfigSchema, runConfigShow, runConfigValidate } from './commands/config.ts';
import { runDbBackup, runDbMigrate, runDbRestore, runDbStatus } from './commands/db.ts';
import { runDoctor } from './commands/doctor.ts';
import { runInit } from './commands/init.ts';
import { runPurge } from './commands/purge.ts';
import { runServe } from './commands/serve.ts';
import { runVersion } from './commands/version.ts';
import type { CliDeps, CommandContext } from './deps.ts';
import { renderCommandHelp } from './help.ts';
import { type CliPlan, EXIT, type Invocation } from './invocation.ts';
import { createOutput, type Output } from './output/output.ts';
import { resolveColorEnabled } from './output/style.ts';
import { planCli } from './plan.ts';

function buildOutput(deps: CliDeps, plan: CliPlan): Output {
  const color = plan.kind === 'exit' ? 'never' : plan.color;
  const stdio = plan.kind === 'run' && plan.stdio;
  const tty = stdio ? deps.streams.isTty.stderr : deps.streams.isTty.stdout;
  return createOutput({
    stdout: deps.streams.stdout,
    stderr: deps.streams.stderr,
    isTty: { stdout: deps.streams.isTty.stdout, stderr: deps.streams.isTty.stderr },
    color: resolveColorEnabled(color, deps.env, tty),
    ...(deps.streams.columns !== undefined && { columns: deps.streams.columns }),
    stdio,
  });
}

/**
 * Dispatches one planned invocation.
 *
 * @returns The exit code.
 */
export async function runInvocation(
  context: CommandContext,
  invocation: Invocation,
): Promise<number> {
  switch (invocation.command) {
    case 'serve':
      return runServe(context, invocation.resolved);
    case 'init':
      return runInit(context, invocation);
    case 'doctor':
      return runDoctor(context, invocation);
    case 'purge':
      return runPurge(context, invocation);
    case 'config-show':
      return runConfigShow(context, invocation.resolved, invocation.json);
    case 'config-schema':
      return runConfigSchema(context);
    case 'config-validate':
      return runConfigValidate(context, invocation.resolved);
    case 'db-status':
      return runDbStatus(context, invocation.dataDir, invocation.json);
    case 'db-backup':
      return runDbBackup(context, invocation.dataDir, invocation.out);
    case 'db-restore':
      return runDbRestore(context, invocation.dataDir, invocation.file, invocation.yes);
    case 'db-migrate':
      return runDbMigrate(context, invocation.dataDir, invocation.dryRun, invocation.json);
    case 'admin-reset-password':
      return runResetPassword(context, invocation.dataDir, invocation.json);
    case 'admin-tokens-list':
      return runTokensList(context, invocation.dataDir, invocation.json, invocation.remote);
    case 'admin-tokens-create':
      return runTokensCreate(context, invocation);
    case 'admin-tokens-revoke':
      return runTokensRevoke(context, invocation);
    case 'version':
      return runVersion(context, invocation.json);
  }
}

function isDebug(deps: CliDeps, plan: CliPlan): boolean {
  if (plan.kind === 'run' && 'resolved' in plan.invocation) {
    const root = plan.invocation.resolved.config.logLevel.root;
    return root === 'debug' || root === 'trace';
  }
  const index = deps.argv.findIndex((arg) => arg === '--logLevel' || arg.startsWith('--logLevel='));
  const raw =
    index < 0
      ? undefined
      : deps.argv[index]?.includes('=')
        ? deps.argv[index]?.split('=')[1]
        : deps.argv[index + 1];
  return raw?.startsWith('debug') === true || raw?.startsWith('trace') === true;
}

/**
 * Renders a thrown error: `browserhive: [CODE] message` plus the registry hint (which names the
 * flag or command that fixes it); unknown errors print `browserhive: fatal: …`. Stacks only in debug.
 *
 * @returns The exit code for the error.
 */
export function reportError(out: Output, error: unknown, debug: boolean): number {
  const facts = appErrorFacts(error);
  if (facts !== null) {
    out.diagnostic(`browserhive: [${facts.code}] ${facts.message}`);
    if (facts.hint !== undefined) out.diagnostic(`hint: ${facts.hint}`);
    if (debug && facts.stack !== undefined) out.diagnostic(facts.stack);
    return facts.exitCode;
  }
  const message = error instanceof Error ? error.message : 'unexpected failure';
  out.diagnostic(`browserhive: fatal: ${message}`);
  if (debug && error instanceof Error && error.stack !== undefined) out.diagnostic(error.stack);
  else
    out.diagnostic(
      "Re-run with --logLevel debug for the stack trace, or run 'browserhive doctor'.",
    );
  return EXIT.fatal;
}

/**
 * Runs the CLI end to end with injected dependencies.
 *
 * @returns The process exit code.
 */
export async function runCli(deps: CliDeps): Promise<number> {
  const plan = planCli(deps.argv, deps.env, deps.configFs, {
    cwd: deps.cwd,
    host: deps.host,
    knownLogModules: deps.logModules,
  });
  const out = buildOutput(deps, plan);
  const context: CommandContext = { deps, out };
  try {
    switch (plan.kind) {
      case 'exit':
        for (const line of plan.lines) out.diagnostic(line);
        return plan.code;
      case 'help':
        // Help always goes to stdout, even when flags name the stdio transport (it starts nothing).
        out.lines(
          renderCommandHelp(plan.topic, {
            version: deps.appVersion,
            width: out.width,
            style: out.style,
          }),
        );
        return EXIT.ok;
      case 'version':
        return await runVersion(context, plan.json);
      case 'run':
        return await runInvocation(context, plan.invocation);
    }
  } catch (error) {
    return reportError(out, error, isDebug(deps, plan));
  }
}

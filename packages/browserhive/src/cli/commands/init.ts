/** @module cli/commands/init — `browserhive init`: data dir (0700) and subdirectories, Chromium for Playwright (and Patchright), the default-browser report and choice, database creation and migration, optional schema file, next steps; idempotent, each step ✓/✗ (spec 08 §7.1, D-18) */
import { dirname, join } from 'node:path';
import { configFileJsonSchema } from '@browserhive/contracts/config';
import type { Channel } from '@browserhive/contracts/enums';
import type { ResolvedConfigBundle } from '@browserhive/core/config';
import type { CommandContext } from '../deps.ts';
import { EXIT, type ExitCode } from '../invocation.ts';
import { appErrorFacts, withStorage } from './common.ts';
import { sandboxModeOf } from './doctor-browsers.ts';
import { stepBrowserChoice } from './init-browser.ts';

/** Subdirectories created under the data dir (D-24). */
export const DATA_SUBDIRS: readonly string[] = [
  'sessions',
  'auth-states',
  'uploads',
  'backups',
  'admin',
];
/** Browser download ceiling. */
export const INSTALL_TIMEOUT_MS = 15 * 60_000;
/** Schema file written by `--writeSchema`. */
export const SCHEMA_FILE = 'browserhive.schema.json';

/** Options of {@link runInit}. */
export interface InitOptions {
  readonly resolved: ResolvedConfigBundle;
  readonly force: boolean;
  readonly skipBrowsers: boolean;
  readonly writeSchema: boolean;
  /** `--channel`: make this the default browser and save it (asks, or needs `--yes`). */
  readonly channel: Channel | null;
  /** `--installChrome`: install Google Chrome with Google's installer. */
  readonly installChrome: boolean;
  /** `--yes`: save the choice without asking. */
  readonly yes: boolean;
}

/**
 * The command an operator runs by hand to retry a failed download.
 *
 * @returns `bunx playwright@1.63.0 install chromium`.
 */
export function retryCommand(driver: 'playwright' | 'patchright', version: string | null): string {
  return `bunx ${driver}${version === null ? '' : `@${version}`} install chromium`;
}

function childEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const copy: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) if (value !== undefined) copy[name] = value;
  return copy;
}

async function stepDataDir(context: CommandContext, dataDir: string): Promise<boolean> {
  const { deps, out } = context;
  try {
    const existed = (await deps.fs.stat(dataDir)) !== null;
    await deps.fs.mkdir(dataDir, { mode: 0o700 });
    for (const sub of DATA_SUBDIRS) await deps.fs.mkdir(join(dataDir, sub), { mode: 0o700 });
    const mode = await deps.probes.pathMode(dataDir);
    if (mode !== null && (mode & 0o077) !== 0) {
      out.status(
        'warn',
        `data directory ${dataDir}`,
        `mode 0${mode.toString(8)}; run 'chmod 700 ${dataDir}'`,
      );
      return true;
    }
    out.status('ok', `data directory ${dataDir}`, existed ? 'already exists' : 'created (0700)');
    return true;
  } catch (err) {
    out.status(
      'fail',
      `data directory ${dataDir}`,
      err instanceof Error ? err.message : 'cannot create',
    );
    return false;
  }
}

async function stepBrowser(
  context: CommandContext,
  driver: 'playwright' | 'patchright',
  options: { readonly force: boolean; readonly optional: boolean },
): Promise<boolean> {
  const { deps, out } = context;
  const label = `Chromium for ${driver === 'playwright' ? 'Playwright' : 'Patchright'}`;
  const probe = driver === 'playwright' ? deps.probes.playwright : deps.probes.patchright;
  const before = await probe.call(deps.probes);
  const soft = options.optional ? 'warn' : 'fail';
  if (before.packageVersion === null) {
    out.status(
      soft,
      label,
      options.optional
        ? `${driver} package not installed (optional); stealth sessions use Playwright`
        : `${driver} package not installed; reinstall browserhive`,
    );
    return options.optional;
  }
  const retry = retryCommand(driver, before.packageVersion);
  if (before.installed && !options.force) {
    out.status(
      'ok',
      `${label} ${before.packageVersion}`,
      `already installed${before.executablePath === null ? '' : ` · ${before.executablePath}`}`,
    );
    return true;
  }
  const command = deps.probes.installCommand(driver);
  if (command === null) {
    out.status(soft, label, `cannot locate the ${driver} CLI; retry with: ${retry}`);
    return options.optional;
  }
  out.line(out.style.dim(`  downloading ${label} (${driver} install chromium)…`));
  const outcome = await deps.runner
    .run(command.command, [...command.args, 'install', 'chromium'], {
      env: childEnv(deps.env),
      timeoutMs: INSTALL_TIMEOUT_MS,
    })
    .then(
      (run) => ({ code: run.code, stderr: run.stderr, timedOut: run.timedOut }),
      (err: unknown) => ({
        code: null,
        stderr: err instanceof Error ? err.message : 'spawn failed',
        timedOut: false,
      }),
    );
  const after = outcome.code === 0 ? await probe.call(deps.probes) : before;
  if (outcome.code === 0 && after.installed) {
    out.status(
      'ok',
      `${label} ${before.packageVersion}`,
      `installed${after.executablePath === null ? '' : ` · ${after.executablePath}`}`,
    );
    return true;
  }
  const why = outcome.timedOut
    ? 'download timed out'
    : outcome.code === 0
      ? 'installer finished but the browser is still missing'
      : `download failed (exit ${outcome.code ?? 'signal'})`;
  const lastLine = outcome.stderr.trim().split('\n').at(-1) ?? '';
  out.status(soft, label, `${why}${lastLine === '' ? '' : `: ${lastLine}`}`);
  out.line(`  Retry with: ${out.style.bold(retry)}`);
  return options.optional;
}

async function stepDatabase(context: CommandContext, dataDir: string): Promise<boolean> {
  const { deps, out } = context;
  const holder = deps.lock.read(dataDir);
  if (holder !== null) {
    out.status('warn', 'database', `skipped: in use by a running BrowserHive (pid ${holder.pid})`);
    return true;
  }
  try {
    const report = await withStorage(
      deps,
      { dataDir, readOnly: false, migrate: true, owner: 'init' },
      (storage) => storage.migrate(),
    );
    const applied = report.applied.length;
    out.status(
      'ok',
      `database schema v${report.to}`,
      applied === 0 ? 'up to date' : `applied ${applied} migration${applied === 1 ? '' : 's'}`,
    );
    return true;
  } catch (err) {
    const facts = appErrorFacts(err);
    const message =
      facts === null
        ? err instanceof Error
          ? err.message
          : 'failed'
        : `[${facts.code}] ${facts.message}`;
    out.status('fail', 'database', message);
    return false;
  }
}

async function stepSchema(
  context: CommandContext,
  resolved: ResolvedConfigBundle,
): Promise<boolean> {
  const { deps, out } = context;
  const configPath = resolved.configFilePath;
  if (configPath === undefined) {
    out.status(
      'warn',
      'schema file',
      `no config file found; run 'browserhive config schema > ${SCHEMA_FILE}'`,
    );
    return true;
  }
  const target = join(dirname(configPath), SCHEMA_FILE);
  try {
    await deps.fs.writeFile(target, `${JSON.stringify(configFileJsonSchema(), null, 2)}\n`);
    out.status('ok', `schema file ${target}`);
    return true;
  } catch (err) {
    out.status(
      'fail',
      `schema file ${target}`,
      err instanceof Error ? err.message : 'cannot write',
    );
    return false;
  }
}

/**
 * Runs `init`.
 *
 * @returns 0 when every required step succeeded, 1 otherwise.
 */
export async function runInit(context: CommandContext, options: InitOptions): Promise<ExitCode> {
  const { out } = context;
  const config = options.resolved.config;
  const results: boolean[] = [];
  results.push(await stepDataDir(context, config.dataDir));
  if (options.skipBrowsers) {
    out.status('ok', 'browsers', 'skipped (--skipBrowsers)');
  } else {
    results.push(
      await stepBrowser(context, 'playwright', { force: options.force, optional: false }),
    );
    if (config.stealthDriver !== 'playwright') {
      results.push(
        await stepBrowser(context, 'patchright', {
          force: options.force,
          optional: config.stealthDriver === 'auto',
        }),
      );
    }
  }
  results.push(
    await stepBrowserChoice(context, {
      resolved: options.resolved,
      channel: options.channel,
      installChrome: options.installChrome,
      yes: options.yes,
      sandbox: sandboxModeOf(config),
    }),
  );
  if (results[0] === true) results.push(await stepDatabase(context, config.dataDir));
  if (options.writeSchema) results.push(await stepSchema(context, options.resolved));

  const ok = results.every(Boolean);
  out.line();
  if (!ok) {
    out.line("Setup is incomplete. Fix the ✗ steps above and run 'browserhive init' again.");
    return EXIT.fatal;
  }
  const url = `http://${config.host}:${config.port}`;
  out.line(out.style.bold('Next steps'));
  out.line(`  ${out.style.bold('browserhive')}           start the MCP server on ${url}/mcp`);
  out.line(`  ${out.style.bold('browserhive --admin')}   also serve the dashboard on ${url}/`);
  out.line(`  ${out.style.bold('browserhive doctor')}    check the host`);
  out.line('  Docs: https://browserhive.ai/docs');
  return EXIT.ok;
}

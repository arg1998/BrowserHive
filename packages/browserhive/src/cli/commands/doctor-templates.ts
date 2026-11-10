/** @module cli/commands/doctor-templates — the session-template checks of `browserhive doctor` (spec 13 §11.9: data, key, display, agents, browsers, profiles, proxies, memory), each from injected probes and a read-only, never-migrating database read; none is listed while no template exists */
import { join } from 'node:path';
import type { ServerConfig } from '@browserhive/contracts/config';
import { RAM_GIB_PER_SESSION } from '@browserhive/core/config';
import type { CliDeps, TemplateRowFacts, TemplateStateFileFacts } from '../deps.ts';
import { databasePath } from './common.ts';
import type { CheckResult, CheckStatus } from './doctor-checks.ts';

const GIB = 1024 ** 3;
const DAY_MS = 86_400_000;
/** Entries a warning names before "and N more". */
const LIST_MAX = 5;

/** What the template checks need besides the deps. */
export interface TemplateCheckInput {
  readonly dataDir: string;
  /** The resolved configuration, `null` when it does not resolve. */
  readonly config: ServerConfig | null;
  /** `templateKey` was given as a command-line flag. */
  readonly keyFromFlag: boolean;
}

/** The template facts every check reads once. */
interface Facts {
  readonly rows: readonly TemplateRowFacts[];
  /** Directories under `templates/`. */
  readonly dirs: readonly string[];
  /** Why `templates/` could not be listed, else `null`. */
  readonly unreadable: string | null;
  readonly templatesDir: string;
  readonly names: ReadonlyMap<string, string>;
}

function result(check: string, status: CheckStatus, detail: string): CheckResult {
  return { check, status, detail };
}

function octal(mode: number): string {
  return `0${(mode & 0o777).toString(8)}`;
}

function listText(items: readonly string[]): string {
  const shown = items.slice(0, LIST_MAX).join(', ');
  return items.length > LIST_MAX ? `${shown} and ${items.length - LIST_MAX} more` : shown;
}

async function readRows(deps: CliDeps, dataDir: string): Promise<readonly TemplateRowFacts[]> {
  if ((await deps.fs.stat(databasePath(dataDir))) === null) return [];
  try {
    const storage = await deps.openStorage({
      dataDir,
      readOnly: true,
      migrate: false,
      owner: 'doctor',
    });
    try {
      return await storage.templateRows();
    } finally {
      await storage.close();
    }
  } catch {
    // The database row reports a database that cannot be opened.
    return [];
  }
}

async function readFacts(deps: CliDeps, dataDir: string): Promise<Facts> {
  const templatesDir = join(dataDir, 'templates');
  const rows = await readRows(deps, dataDir);
  const dirs: string[] = [];
  let unreadable: string | null = null;
  if ((await deps.fs.stat(templatesDir)) !== null) {
    try {
      for (const name of await deps.fs.readdir(templatesDir)) {
        if ((await deps.fs.stat(join(templatesDir, name)))?.isDirectory === true) dirs.push(name);
      }
    } catch (err) {
      unreadable = err instanceof Error ? err.message : 'cannot be read';
    }
  }
  const names = new Map(rows.map((row) => [row.templateId, row.name]));
  return { rows, dirs, unreadable, templatesDir, names };
}

/** `templates/` and `admin/` 0700, each template's directories 0700 and its version files 0600. */
async function checkData(deps: CliDeps, facts: Facts, dataDir: string): Promise<CheckResult> {
  const name = 'templates data';
  if (facts.unreadable !== null) {
    return result(name, 'fail', `${facts.templatesDir} cannot be read: ${facts.unreadable}`);
  }
  const count = `${facts.dirs.length} template director${facts.dirs.length === 1 ? 'y' : 'ies'}`;
  if (deps.host.platform === 'win32') {
    return result(name, 'ok', `${count}; modes are not checked on Windows`);
  }
  const paths = [facts.templatesDir, join(dataDir, 'admin')];
  for (const id of facts.dirs) {
    const versions = join(facts.templatesDir, id, 'versions');
    paths.push(join(facts.templatesDir, id), versions);
    const files = await deps.fs.readdir(versions).catch(() => []);
    for (const file of files.filter((f) => /\.(state\.enc|meta\.json)$/.test(f))) {
      paths.push(join(versions, file));
    }
  }
  const broad: string[] = [];
  for (const path of paths) {
    const mode = await deps.probes.pathMode(path);
    if (mode !== null && (mode & 0o077) !== 0) broad.push(`${path} (${octal(mode)})`);
  }
  if (broad.length > 0) {
    return result(
      name,
      'warn',
      `broader than owner-only: ${listText(broad)}; run 'chmod -R go-rwx ${facts.templatesDir}'`,
    );
  }
  return result(name, 'ok', `${count} · owner-only`);
}

/** The key id of a base64 key text, `null` when it is not a key. */
async function keyIdOf(text: string | undefined | null): Promise<string | null> {
  if (text === undefined || text === null) return null;
  const server = await import('@browserhive/core/server');
  const bytes = server.decodeTemplateKey(text);
  return bytes === null ? null : server.templateKeyOf(bytes).keyId;
}

function templatesOf(files: readonly TemplateStateFileFacts[], facts: Facts): string[] {
  return [...new Set(files.map((f) => facts.names.get(f.templateId) ?? f.templateId))].sort();
}

/** The key resolves, its file is 0600, and every file's header names it (spec 13 §2.4). */
async function checkKey(
  deps: CliDeps,
  facts: Facts,
  input: TemplateCheckInput,
): Promise<CheckResult> {
  const name = 'template key';
  const files = await deps.probes.templateStateFiles(facts.templatesDir);
  const path = join(input.dataDir, 'admin', 'template.key');
  const configured = input.config?.templateKey;
  let current = await keyIdOf(configured);
  let source = 'templateKey';
  const warnings: string[] = [];
  if (configured === undefined) {
    source = path;
    const text = (await deps.fs.stat(path)) === null ? null : await deps.fs.readFile(path);
    current = await keyIdOf(text);
    if (text !== null && current === null) warnings.push(`${path} does not hold a template key`);
    const mode = text === null ? null : await deps.probes.pathMode(path);
    if (mode !== null && deps.host.platform !== 'win32' && (mode & 0o077) !== 0) {
      warnings.push(`${path} has mode ${octal(mode)}; run 'chmod 600 ${path}'`);
    }
  }
  if (files.length > 0 && current === null) {
    return result(
      name,
      'fail',
      `[TEMPLATE_KEY_MISSING] ${files.length} encrypted file(s) and no key resolves${warnings.length > 0 ? ` (${warnings[0]})` : ''}: set templateKey (BROWSERHIVE_TEMPLATE_KEY) or restore ${path}`,
    );
  }
  if (input.keyFromFlag) {
    warnings.push(
      'templateKey is given as a command-line flag, which other users of this machine can read; use BROWSERHIVE_TEMPLATE_KEY',
    );
  }
  const previous = await keyIdOf(input.config?.templateKeyPrevious);
  const onPrevious = files.filter((f) => f.keyId !== current && f.keyId === previous);
  const foreign = files.filter((f) => f.keyId !== current && f.keyId !== previous);
  if (foreign.length > 0) {
    warnings.push(
      `${listText(templatesOf(foreign, facts))}: ${foreign.length} file(s) written with another key cannot be read; set the key that wrote them as templateKeyPrevious, or as templateKey and run 'browserhive templates rekey'`,
    );
  }
  if (onPrevious.length > 0) {
    warnings.push(
      `${onPrevious.length} file(s) still on templateKeyPrevious; run 'browserhive templates rekey --oldKeyEnv <ENV>' with the server stopped`,
    );
  }
  if (warnings.length > 0) return result(name, 'warn', warnings.join('; '));
  if (current === null) return result(name, 'ok', 'no key yet; created at the first checkpoint');
  return result(name, 'ok', `from ${source} · ${files.length} file(s) on it`);
}

/** A display (or a session) for headed templates (spec 13 §3.11). */
function checkDisplay(deps: CliDeps, facts: Facts): CheckResult {
  const name = 'template display';
  const headed = facts.rows.filter((row) => !row.headless);
  if (headed.length === 0) return result(name, 'ok', 'every template is headless');
  const platform = deps.host.platform;
  if (platform === 'darwin') {
    return result(
      name,
      'ok',
      'macOS: headed browsers need a logged-in GUI session; run BrowserHive as a LaunchAgent, not a LaunchDaemon',
    );
  }
  if (platform === 'win32') {
    return result(
      name,
      'ok',
      'Windows: headed browsers need an interactive session; not a service in session 0',
    );
  }
  const set = (key: string): string | null => {
    const value = deps.env[key];
    return value === undefined || value === '' ? null : value;
  };
  const display = set('DISPLAY');
  const wayland = set('WAYLAND_DISPLAY');
  if (display !== null || wayland !== null) {
    // A desktop session sets XDG_SESSION_TYPE; a bare Xvfb without -auth accepts any local client.
    if (wayland === null && set('XAUTHORITY') === null && set('XDG_SESSION_TYPE') === null) {
      return result(
        name,
        'warn',
        `DISPLAY=${display} without XAUTHORITY: an Xvfb started without -auth lets any local user see and type into the windows; start it with -auth <file> and export XAUTHORITY`,
      );
    }
    return result(name, 'ok', `display ${display ?? wayland}`);
  }
  if (headed.every((row) => row.chromeMajor !== null)) {
    return result(
      name,
      'ok',
      'no display in this shell; every headed template browser has started on this machine before',
    );
  }
  const never = headed.filter((row) => row.chromeMajor === null).map((row) => row.name);
  return result(
    name,
    'fail',
    `${listText(never)}: headed, and no display (DISPLAY or WAYLAND_DISPLAY). Start a virtual display (Xvfb :99 -auth <file>, then DISPLAY=:99 and XAUTHORITY=<file>, or xvfb-run), add a VNC server on it to see the window from elsewhere, or make the template headless`,
  );
}

/** Agents running as this OS user can read the templates (spec 13 §5.4, §13). */
function checkAgents(config: ServerConfig): CheckResult {
  const name = 'template agents';
  if (config.transport === 'stdio' || config.auth === 'off') {
    return result(
      name,
      'warn',
      'agents that can run commands as this user can read the templates directly; run BrowserHive as a separate user or in a container, over HTTP with per-agent tokens',
    );
  }
  return result(name, 'ok', 'transport http with auth=token');
}

const INSTALL: Readonly<Record<TemplateRowFacts['channel'], string>> = {
  chromium: "run 'browserhive init'",
  chrome: "run 'browserhive init --installChrome' (needs administrator rights)",
  edge: 'install Microsoft Edge from https://www.microsoft.com/edge',
};

/** Each template's channel is installed; the installed major still matches the observed one. */
async function checkBrowsers(deps: CliDeps, facts: Facts): Promise<CheckResult> {
  const name = 'template browsers';
  const browsers = await deps.probes.browsers();
  const missing: string[] = [];
  const drift: string[] = [];
  for (const channel of [...new Set(facts.rows.map((row) => row.channel))]) {
    const users = facts.rows.filter((row) => row.channel === channel);
    const browser = browsers.find((b) => b.channel === channel);
    if (browser?.installed !== true) {
      missing.push(
        `${listText(users.map((u) => u.name))} use ${browser?.label ?? channel}, which is not installed: ${INSTALL[channel]}`,
      );
      continue;
    }
    const major = browser.version?.split('.')[0] ?? null;
    for (const row of users) {
      if (row.chromeMajor !== null && major !== null && row.chromeMajor !== major) {
        drift.push(`${row.name} (${row.chromeMajor} → ${major})`);
      }
    }
  }
  if (missing.length > 0) return result(name, 'fail', missing.join('; '));
  if (drift.length > 0) {
    return result(
      name,
      'warn',
      `browser updated since the first start: ${listText(drift)}; sites may treat the next visit as a new device`,
    );
  }
  return result(name, 'ok', 'every template browser is installed');
}

/** No saved passwords or autofill data in any template profile (spec 13 §3.1). */
async function checkProfiles(deps: CliDeps, facts: Facts): Promise<CheckResult> {
  const name = 'template profiles';
  const found: string[] = [];
  for (const row of facts.rows) {
    const userdata = join(facts.templatesDir, row.templateId, 'userdata');
    if (await deps.probes.profileHasSecrets(userdata)) found.push(row.name);
  }
  if (found.length > 0) {
    return result(
      name,
      'warn',
      `${listText(found)}: saved passwords or autofill data in the browser profile, which agents' pages may be offered; clear them from the template page`,
    );
  }
  return result(name, 'ok', 'no saved passwords or autofill data');
}

/** Every proxy password variable is set (names only, never a value). */
function checkProxies(deps: CliDeps, facts: Facts): CheckResult {
  const name = 'template proxies';
  const withEnv = facts.rows.filter((row) => row.proxyPasswordEnv !== null);
  const unset = withEnv.filter((row) => {
    const value = deps.env[row.proxyPasswordEnv ?? ''];
    return value === undefined || value === '';
  });
  if (unset.length > 0) {
    return result(
      name,
      'fail',
      unset.map((row) => `${row.name}: ${row.proxyPasswordEnv} is not set`).join('; '),
    );
  }
  if (withEnv.length === 0) return result(name, 'ok', 'no proxy password variables');
  return result(name, 'ok', `${withEnv.length} proxy password variable(s) set`);
}

/** `maxSessions` against RAM, each template used in the last 24 h at `templateRecycleRss` (§6.3). */
function checkMemory(deps: CliDeps, facts: Facts, config: ServerConfig): CheckResult {
  const name = 'template memory';
  const since = deps.clock.now() - DAY_MS;
  const recent = facts.rows.filter((row) => row.lastUsedAt !== null && row.lastUsedAt >= since);
  if (recent.length === 0) return result(name, 'ok', 'no template used in the last 24 h');
  const max = config.maxSessions;
  if (max === 'unbounded') {
    return result(
      name,
      'ok',
      `${recent.length} template(s) used in the last 24 h; maxSessions unbounded (see max sessions)`,
    );
  }
  const rss = config.templateRecycleRss;
  const hosts = Math.min(recent.length, max);
  const needed = hosts * rss + (max - hosts) * RAM_GIB_PER_SESSION * GIB;
  const gib = (bytes: number): string => `${(bytes / GIB).toFixed(1)} GiB`;
  const detail = `${max} sessions with ${recent.length} template browser(s) used in the last 24 h at ${gib(rss)} each need about ${gib(needed)}; ${gib(deps.host.totalMemoryBytes)} RAM`;
  if (needed > deps.host.totalMemoryBytes) {
    return result(name, 'warn', `${detail}. Lower maxSessions or templateRecycleRss`);
  }
  return result(name, 'ok', detail);
}

/**
 * The template checks of spec 13 §11.9 except `template access` (T1a, in `doctor-checks.ts`) and
 * `site packs` (T3a). Empty while no template exists (no row and no template directory).
 *
 * @returns The rows, in display order.
 */
export async function checkTemplates(
  deps: CliDeps,
  input: TemplateCheckInput,
): Promise<readonly CheckResult[]> {
  const facts = await readFacts(deps, input.dataDir);
  if (facts.rows.length === 0 && facts.dirs.length === 0 && facts.unreadable === null) return [];
  const results: CheckResult[] = [
    await checkData(deps, facts, input.dataDir),
    await checkKey(deps, facts, input),
  ];
  if (facts.rows.length === 0) return results;
  results.push(checkDisplay(deps, facts));
  if (input.config !== null) results.push(checkAgents(input.config));
  results.push(await checkBrowsers(deps, facts), await checkProfiles(deps, facts));
  results.push(checkProxies(deps, facts));
  if (input.config !== null) results.push(checkMemory(deps, facts, input.config));
  return results;
}

/**
 * @module test/stealth/probe — the stealth and sandbox measurement harness (plan §6). Every value is
 * measured **through BrowserHive**: `createServer` → MCP over Streamable HTTP → `launch_session` →
 * `navigate` to a local `Bun.serve` page → `evaluate`. Only the reference engine version comes from a
 * raw Playwright launch, because it is the ground truth the page-visible version is compared with.
 *
 * Used by `scripts/stealth-matrix.ts` (the cross-OS CI job) and by the stealth-parity integration test.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { platform, release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { chromium } from 'playwright';
import { createServer } from '../../src/index.ts';

/** A channel name as `launch_session` accepts it. */
export type ProbeChannel = 'chromium' | 'chrome' | 'edge';
/** The server's `stealth` level. */
export type ProbeStealth = 'standard' | 'max';
/**
 * How the sandbox is requested: `off` (today's default), `session` (per-session
 * `launch_options.chromiumSandbox: true`, the only route before the `sandbox` key existed), or a
 * value of the server's `sandbox` key (`config:auto`, `config:on`).
 */
export type ProbeSandbox = 'off' | 'session' | 'config:auto' | 'config:on' | 'config:off';

/** What the page reported (null fields: the API is absent). */
export interface PageSignals {
  readonly ua: string;
  readonly brands: readonly string[] | null;
  readonly fullVersionList: readonly string[] | null;
  readonly uaFullVersion: string | null;
  readonly webdriver: boolean | null;
  readonly chrome: string;
  readonly plugins: number;
  readonly pdfViewerEnabled: boolean | null;
  readonly h264: string;
  readonly aac: string;
  readonly screen: string;
  readonly viewport: string;
  readonly webgl: string | null;
  readonly notificationsQuery: string | null;
  readonly notificationPermission: string | null;
}

/** One measured cell of the matrix. */
export interface ProbeRow {
  readonly channel: ProbeChannel;
  readonly stealth: ProbeStealth;
  readonly sandbox: ProbeSandbox;
  /** `launched`, `failed` (a typed error came back) or `skipped` (browser not installed). */
  readonly outcome: 'launched' | 'failed' | 'skipped';
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly retryable: string | null;
  /** Whether the browser processes ran without `--no-sandbox`; null when they could not be listed. */
  readonly sandboxed: boolean | null;
  readonly signals: PageSignals | null;
  /** The engine's real full version (raw Playwright `browser.version()`), or null when unknown. */
  readonly engineVersion: string | null;
  /** Checks of plan §6 that failed, empty when all passed. */
  readonly problems: readonly string[];
  readonly launchMs: number | null;
}

/** Host facts that decide whether a sandbox can work. */
export interface HostFactsReport {
  readonly platform: string;
  readonly release: string;
  readonly uid: number | null;
  readonly apparmorRestrictUserns: string | null;
  readonly unprivilegedUsernsClone: string | null;
  readonly container: boolean;
}

function readTrimmed(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
}

/** Facts about this host relevant to the sandbox (Linux sysctls, uid, container markers). */
export function hostFacts(): HostFactsReport {
  return {
    platform: platform(),
    release: release(),
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    apparmorRestrictUserns: readTrimmed('/proc/sys/kernel/apparmor_restrict_unprivileged_userns'),
    unprivilegedUsernsClone: readTrimmed('/proc/sys/kernel/unprivileged_userns_clone'),
    container: existsSync('/.dockerenv') || existsSync('/run/.containerenv'),
  };
}

/** Command lines of every running process (best effort, per OS). */
export function processCommandLines(): readonly string[] | null {
  const os = platform();
  if (os === 'linux') {
    const lines: string[] = [];
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      const raw = readTrimmed(`/proc/${entry}/cmdline`);
      if (raw !== null && raw !== '') lines.push(raw.split('\0').join(' '));
    }
    return lines;
  }
  const run =
    os === 'win32'
      ? spawnSync(
          'powershell',
          [
            '-NoProfile',
            '-Command',
            'Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }',
          ],
          { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
        )
      : spawnSync('ps', ['-axww', '-o', 'args='], {
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
        });
  if (run.status !== 0) return null;
  return run.stdout.split(/\r?\n/).filter((line) => line.trim() !== '');
}

/**
 * Whether the browser processes Playwright started run with the sandbox. Playwright always passes
 * `--remote-debugging-pipe` to the browser process, and adds `--no-sandbox` when the sandbox is off.
 *
 * @returns `true` (none carries `--no-sandbox`), `false`, or null when no browser process was found.
 */
export function browsersSandboxed(): boolean | null {
  const lines = processCommandLines();
  if (lines === null) return null;
  const browsers = lines.filter((line) => line.includes('--remote-debugging-pipe'));
  if (browsers.length === 0) return null;
  return !browsers.some((line) => line.includes('--no-sandbox'));
}

/** The page-side probe; returns {@link PageSignals}. Kept as source text for the `evaluate` tool. */
export const PROBE_EXPRESSION = `async () => {
  const uad = navigator.userAgentData;
  let high = null;
  try { high = uad ? await uad.getHighEntropyValues(['fullVersionList', 'uaFullVersion']) : null; } catch { high = null; }
  let webgl = null;
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    webgl = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : null;
  } catch { webgl = null; }
  let notificationsQuery = null;
  try { notificationsQuery = (await navigator.permissions.query({ name: 'notifications' })).state; } catch { notificationsQuery = null; }
  return {
    ua: navigator.userAgent,
    brands: uad ? uad.brands.map((b) => b.brand + '/' + b.version) : null,
    fullVersionList: high && high.fullVersionList ? high.fullVersionList.map((b) => b.brand + '/' + b.version) : null,
    uaFullVersion: high && high.uaFullVersion ? high.uaFullVersion : null,
    webdriver: typeof navigator.webdriver === 'boolean' ? navigator.webdriver : null,
    chrome: typeof window.chrome,
    plugins: navigator.plugins.length,
    pdfViewerEnabled: typeof navigator.pdfViewerEnabled === 'boolean' ? navigator.pdfViewerEnabled : null,
    h264: document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E"'),
    aac: document.createElement('audio').canPlayType('audio/mp4; codecs="mp4a.40.2"'),
    screen: screen.width + 'x' + screen.height,
    viewport: innerWidth + 'x' + innerHeight,
    webgl,
    notificationsQuery,
    notificationPermission: typeof Notification === 'undefined' ? null : Notification.permission,
  };
}`;

const PLAYWRIGHT_CHANNEL: Readonly<Record<ProbeChannel, string>> = {
  chromium: 'chromium',
  chrome: 'chrome',
  edge: 'msedge',
};

/** The real engine version of a channel (raw Playwright), or null when it cannot launch. */
export async function engineVersion(channel: ProbeChannel): Promise<string | null> {
  try {
    const browser = await chromium.launch({ channel: PLAYWRIGHT_CHANNEL[channel], headless: true });
    try {
      return browser.version();
    } finally {
      await browser.close();
    }
  } catch {
    return null;
  }
}

/**
 * Diagnostics only: the raw Playwright error of a sandboxed launch of `channel`, so a CI summary shows
 * the text BrowserHive's classifier has to recognise. Not a stealth or sandbox claim.
 *
 * @returns The first lines of the error, or null when the sandboxed launch works.
 */
export async function rawSandboxError(channel: ProbeChannel): Promise<string | null> {
  try {
    const browser = await chromium.launch({
      channel: PLAYWRIGHT_CHANNEL[channel],
      headless: true,
      chromiumSandbox: true,
    });
    await browser.close();
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    return message.split('\n').slice(0, 40).join('\n');
  }
}

/**
 * Checks of plan §6 against one row's signals.
 *
 * @returns The failed checks, empty when all passed.
 */
export function stealthProblems(
  _channel: ProbeChannel,
  stealth: ProbeStealth,
  signals: PageSignals,
  engine: string | null,
): string[] {
  const problems: string[] = [];
  if (signals.ua.includes('HeadlessChrome')) problems.push('UA contains HeadlessChrome');
  // Every channel is presented as Google Chrome today, Edge included (a known incoherence with
  // Edge's `Edg/` UA, plan §11): the check pins that behaviour so a change is noticed, and that
  // real Chrome's own brand is not duplicated by the relabel.
  const branded = (signals.brands ?? []).filter((b) => b.startsWith('Google Chrome/')).length;
  if (branded !== 1) problems.push(`brands list Google Chrome ${branded} times`);
  if (signals.webdriver !== false) problems.push(`navigator.webdriver is ${signals.webdriver}`);
  if (signals.chrome !== 'object') problems.push(`window.chrome is ${signals.chrome}`);
  if (signals.plugins !== 5) problems.push(`plugins.length is ${signals.plugins}`);
  if (signals.pdfViewerEnabled !== true) problems.push('pdfViewerEnabled is not true');
  if (signals.h264 !== 'probably') problems.push(`H.264 is '${signals.h264}'`);
  if (signals.aac !== 'probably') problems.push(`AAC is '${signals.aac}'`);
  if (engine !== null) {
    const listed = (signals.fullVersionList ?? []).filter((b) => !b.startsWith('Not'));
    const wrong = listed.filter((b) => b.split('/')[1] !== engine);
    if (listed.length === 0 || wrong.length > 0)
      problems.push(`fullVersionList ${JSON.stringify(signals.fullVersionList)} != ${engine}`);
  }
  if (stealth === 'max' && signals.screen === '1280x720') problems.push('max: screen is 1280x720');
  return problems;
}

/** The page-visible fields sandbox on/off must agree on (everything a page can read). */
export function parityKey(signals: PageSignals): string {
  return JSON.stringify(signals);
}

interface ToolOutcome {
  readonly ok: boolean;
  readonly data: Record<string, unknown>;
}

function parseContent(result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
  // Errors carry `McpErrorContent` under `_meta['browserhive.ai/error']` (spec 02 §2.4).
  const error: unknown = result._meta?.['browserhive.ai/error'];
  if (typeof error === 'object' && error !== null) return { ...error };
  if (typeof result.structuredContent === 'object' && result.structuredContent !== null) {
    return { ...result.structuredContent };
  }
  const content = Array.isArray(result.content) ? result.content : [];
  const first: unknown = content[0];
  if (typeof first === 'object' && first !== null && 'text' in first) {
    const text = first.text;
    if (typeof text === 'string') {
      try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed === 'object' && parsed !== null) return { ...parsed };
      } catch {
        return { message: text };
      }
    }
  }
  return {};
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
  return { ok: result.isError !== true, data: parseContent(result) };
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asSignals(value: unknown): PageSignals | null {
  if (typeof value !== 'object' || value === null || !('ua' in value)) return null;
  return value as PageSignals;
}

/** Options of {@link runMatrix}. */
export interface MatrixOptions {
  readonly channels: readonly ProbeChannel[];
  readonly stealth: readonly ProbeStealth[];
  readonly sandbox: readonly ProbeSandbox[];
  /** Called after each row, for progress output. */
  readonly onRow?: (row: ProbeRow) => void;
}

const silent = { stdout: (): void => undefined, stderr: (): void => undefined };

/** Groups the sandbox modes by the server config they need (one server per group). */
function serverSandboxFor(mode: ProbeSandbox): string | undefined {
  return mode.startsWith('config:') ? mode.slice('config:'.length) : undefined;
}

/**
 * Measures every channel × stealth × sandbox cell through BrowserHive.
 *
 * @returns One row per cell.
 */
export async function runMatrix(options: MatrixOptions): Promise<ProbeRow[]> {
  const pages = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () =>
      new Response('<!doctype html><title>probe</title><p>probe</p>', {
        headers: { 'content-type': 'text/html' },
      }),
  });
  const engines = new Map<ProbeChannel, string | null>();
  for (const channel of options.channels) engines.set(channel, await engineVersion(channel));
  const rows: ProbeRow[] = [];
  try {
    for (const stealth of options.stealth) {
      // One server per sandbox setting; `on` gets one per channel, as that channel's default, so
      // its boot preflight checks exactly the browser being measured.
      const servers: {
        readonly sandbox: string;
        readonly channels: readonly ProbeChannel[];
        readonly modes: ProbeSandbox[];
      }[] = [];
      for (const mode of options.sandbox) {
        const serverSandbox = serverSandboxFor(mode) ?? '';
        if (serverSandbox === 'on') {
          for (const channel of options.channels)
            servers.push({ sandbox: 'on', channels: [channel], modes: [mode] });
          continue;
        }
        const existing = servers.find((s) => s.sandbox === serverSandbox && s.channels.length > 1);
        if (existing !== undefined) existing.modes.push(mode);
        else servers.push({ sandbox: serverSandbox, channels: options.channels, modes: [mode] });
      }
      for (const spec of servers) {
        const dataDir = mkdtempSync(join(tmpdir(), 'bh-matrix-'));
        const server = await createServer({
          port: 0,
          dataDir,
          env: {},
          configFile: false,
          output: silent,
          stealth,
          ...(spec.sandbox !== '' && ({ sandbox: spec.sandbox } as Record<string, unknown>)),
          ...(spec.sandbox === 'on' && { defaultChannel: spec.channels[0] }),
        });
        try {
          try {
            await server.listen();
          } catch (err) {
            // `sandbox=on` refusing to start is a measured outcome, not a harness failure.
            const code =
              typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : null;
            const details: unknown =
              typeof err === 'object' && err !== null && 'details' in err ? err.details : null;
            const reason =
              typeof details === 'object' && details !== null && 'reason' in details
                ? String(details.reason)
                : null;
            const message =
              err instanceof Error
                ? `${err.message}${reason === null ? '' : ` (reason: ${reason})`}`
                : null;
            for (const channel of spec.channels) {
              for (const sandbox of spec.modes) {
                const row: ProbeRow = {
                  channel,
                  stealth,
                  sandbox,
                  outcome:
                    message !== null && /is not installed/.test(message) ? 'skipped' : 'failed',
                  errorCode: code === null ? null : `boot:${code}`,
                  errorMessage: message,
                  retryable: null,
                  sandboxed: null,
                  signals: null,
                  engineVersion: engines.get(channel) ?? null,
                  problems: [],
                  launchMs: null,
                };
                rows.push(row);
                options.onRow?.(row);
              }
            }
            continue;
          }
          const client = new Client({ name: 'stealth-matrix', version: '1.0.0' });
          await client.connect(
            new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)) as Transport,
          );
          try {
            for (const channel of spec.channels) {
              for (const sandbox of spec.modes) {
                const row = await measure(client, {
                  channel,
                  stealth,
                  sandbox,
                  url: `http://127.0.0.1:${pages.port}/`,
                  engine: engines.get(channel) ?? null,
                });
                rows.push(row);
                options.onRow?.(row);
              }
            }
          } finally {
            await client.close();
          }
        } finally {
          await server.stop();
          rmSync(dataDir, { recursive: true, force: true });
        }
      }
    }
  } finally {
    pages.stop(true);
  }
  return rows;
}

async function measure(
  client: Client,
  cell: {
    readonly channel: ProbeChannel;
    readonly stealth: ProbeStealth;
    readonly sandbox: ProbeSandbox;
    readonly url: string;
    readonly engine: string | null;
  },
): Promise<ProbeRow> {
  const base = {
    channel: cell.channel,
    stealth: cell.stealth,
    sandbox: cell.sandbox,
    engineVersion: cell.engine,
  };
  const started = performance.now();
  const launched = await call(client, 'launch_session', {
    slug: `probe-${cell.channel}`,
    channel: cell.channel,
    headless: true,
    ...(cell.sandbox === 'session' && { launch_options: { chromiumSandbox: true } }),
  });
  const launchMs = Math.round(performance.now() - started);
  if (!launched.ok) {
    const code = str(launched.data['code']);
    return {
      ...base,
      outcome: code === 'BROWSER_NOT_INSTALLED' ? 'skipped' : 'failed',
      errorCode: code,
      errorMessage: str(launched.data['message']),
      retryable: str(launched.data['retryable']),
      sandboxed: null,
      signals: null,
      problems: [],
      launchMs,
    };
  }
  const sessionId = str(launched.data['session_id']) ?? '';
  try {
    const sandboxed = browsersSandboxed();
    const nav = await call(client, 'navigate', { session_id: sessionId, url: cell.url });
    if (!nav.ok) throw new Error(`navigate failed: ${JSON.stringify(nav.data)}`);
    const evaluated = await call(client, 'evaluate', {
      session_id: sessionId,
      expression: PROBE_EXPRESSION,
    });
    const signals = asSignals(evaluated.data['result']);
    if (!evaluated.ok || signals === null) {
      throw new Error(`evaluate failed: ${JSON.stringify(evaluated.data)}`);
    }
    return {
      ...base,
      outcome: 'launched',
      errorCode: null,
      errorMessage: null,
      retryable: null,
      sandboxed,
      signals,
      problems: stealthProblems(cell.channel, cell.stealth, signals, cell.engine),
      launchMs,
    };
  } finally {
    await call(client, 'close_session', { session_id: sessionId });
  }
}

/**
 * Sandbox on/off parity: for each channel × stealth, every launched row must report the same
 * page-visible signals as the unsandboxed (`off` / `config:off`) row.
 *
 * @returns Human-readable mismatches, empty when every pair agrees.
 */
export function parityProblems(rows: readonly ProbeRow[]): string[] {
  const problems: string[] = [];
  const launched = rows.filter((r) => r.outcome === 'launched' && r.signals !== null);
  for (const row of launched) {
    if (row.sandbox === 'off' || row.sandbox === 'config:off') continue;
    const baseline = launched.find(
      (r) =>
        r.channel === row.channel &&
        r.stealth === row.stealth &&
        (r.sandbox === 'off' || r.sandbox === 'config:off'),
    );
    if (baseline?.signals == null || row.signals === null) continue;
    const a = baseline.signals;
    const b = row.signals;
    for (const field of Object.keys(a) as (keyof PageSignals)[]) {
      // The display fingerprint is seeded per session id, so `max` rows legitimately differ there.
      if (row.stealth === 'max' && (field === 'screen' || field === 'viewport')) continue;
      if (JSON.stringify(a[field]) !== JSON.stringify(b[field])) {
        problems.push(
          `${row.channel}/${row.stealth}: ${field} differs between ${baseline.sandbox} (${JSON.stringify(a[field])}) and ${row.sandbox} (${JSON.stringify(b[field])})`,
        );
      }
    }
  }
  return problems;
}

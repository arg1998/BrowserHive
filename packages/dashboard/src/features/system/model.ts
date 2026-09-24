/** @module features/system/model — pure mapping of `/system` and `/health` onto the page: KPI values, grouped settings in effect, runtime rows with problems and fix hints, the health view (including the degraded 503 body) and the page-level notices */
import { HealthResponse, type SystemInfo } from '@browserhive/contracts/http';
import { isAppError } from '@/lib/api/errors.ts';
import { formatBytes, formatNumber, formatPercent } from '@/lib/format/bytes.ts';
import { DISK_WARN, diskTone, type Tone } from '@/lib/status-registry.ts';

/** One row of a settings list. */
export interface SettingRow {
  readonly label: string;
  readonly value: string;
  /** Mono for identifiers, paths and addresses only; enum values and numbers stay sans. */
  readonly mono?: boolean;
  /** Path-like value: wraps at `/` rather than mid-segment. */
  readonly path?: boolean;
  /** De-emphasised value (nothing to act on). */
  readonly muted?: boolean;
  /** Colours the value when it needs attention. */
  readonly tone?: Tone;
  /** One-line explanation behind an info button; `--flags` and tool names render as code. */
  readonly hint?: string;
  /** Configuration key whose reference entry the info button links to (`maxSessions`). */
  readonly configKey?: string;
  /** What to do about a problem value (shown under it). */
  readonly fix?: string;
  /** Value to copy (paths, addresses). */
  readonly copy?: string;
}

/** A titled group of settings. */
export interface SettingGroup {
  readonly id: string;
  readonly title: string;
  readonly rows: readonly SettingRow[];
}

const onOff = (value: boolean) => (value ? 'On' : 'Off');

/** Database fill ratio against the retention byte cap (0 when uncapped). */
export function dbRatio(system: SystemInfo): number {
  return system.retention.bytes > 0 ? system.storage.db_bytes / system.retention.bytes : 0;
}

/** `true` when `evaluate` can read a filled credential (enabled while the vault is in use). */
export function evaluateRisky(system: SystemInfo): boolean {
  return system.allow_evaluate && system.vault.enabled;
}

/** Static configuration, grouped for reading (never KPI tiles). */
export function settingsGroups(s: SystemInfo): readonly SettingGroup[] {
  return [
    {
      id: 'server',
      title: 'Server',
      rows: [
        { label: 'Version', value: s.version },
        {
          label: 'Transport',
          value: s.transport,
          hint: 'How MCP clients reach the server: http (Streamable HTTP, with the dashboard and API on the same port) or stdio. Set with --transport.',
          configKey: 'transport',
        },
        {
          label: 'Bind address',
          value: `${s.host}:${s.port}`,
          mono: true,
          copy: `${s.host}:${s.port}`,
          hint: 'Where MCP clients and this dashboard connect. A non-loopback host requires --auth token or --allowInsecureBind.',
          configKey: 'host',
        },
        {
          label: 'Agent authentication',
          value: s.auth_mode === 'token' ? 'Bearer token required' : 'Off (local principal)',
          ...(s.auth_mode === 'off' && { tone: 'warn' as const }),
          hint: 'With --auth token every /mcp request needs Authorization: Bearer <token>. Create agent tokens on the Agent tokens tab.',
          configKey: 'auth',
        },
        {
          label: 'Data directory',
          value: s.data_dir,
          mono: true,
          path: true,
          copy: s.data_dir,
          hint: 'Database, saved logins, persistent profiles, traces and backups live here. Set with --dataDir.',
          configKey: 'dataDir',
        },
      ],
    },
    {
      id: 'sessions',
      title: 'Sessions',
      rows: [
        {
          label: 'Max sessions',
          value: s.capacity.max === null ? 'Unbounded' : formatNumber(s.capacity.max),
          hint: `Sessions requested past the cap are refused. Source: ${s.capacity.max_source}. Set with --maxSessions.`,
          configKey: 'maxSessions',
        },
        {
          label: 'Persistence',
          value: s.persistence_mode,
          hint: 'Default for new sessions: memory (nothing kept), persistent (reused profile) or storage-state (cookies snapshot). Set with --persistence.',
          configKey: 'persistence',
        },
        {
          label: 'Evaluate tool',
          value: s.allow_evaluate ? 'Enabled' : 'Disabled',
          ...(evaluateRisky(s) && { tone: 'danger' as const }),
          hint: 'Arbitrary page scripting. It can read a vault credential after vault_fill, so it is a risk only while the vault is in use. Set with --allowEvaluate.',
          configKey: 'allowEvaluate',
        },
        {
          label: 'URL blocklist',
          value: s.blocklist.configured ? `${formatNumber(s.blocklist.patterns)} patterns` : 'Off',
          ...(s.blocklist.path !== null && { copy: s.blocklist.path }),
          hint: 'Destinations agents may never open. Set with --blocklist <file>.',
          configKey: 'blocklist',
        },
        {
          label: 'Retention',
          value: `${formatNumber(s.retention.days)} days${s.retention.bytes > 0 ? ` · ${formatBytes(s.retention.bytes)} cap` : ''}`,
          hint: 'Events older than this, or past the byte cap, are pruned. Set with --retentionDays and --retentionBytes.',
          configKey: 'retentionDays',
        },
      ],
    },
    {
      id: 'stealth',
      title: 'Stealth',
      rows: [
        {
          label: 'Profile',
          value: s.stealth.profile,
          hint: 'off (raw Playwright), standard (patched driver and hardened launch) or max (adds a display fingerprint). Set with --stealth.',
          configKey: 'stealth',
        },
        {
          label: 'Driver',
          value: s.stealth.driver,
          hint: 'patchright hides the CDP Runtime.enable leak; playwright is used when Patchright is absent. Set with --stealthDriver.',
          configKey: 'stealthDriver',
        },
        {
          label: 'Fingerprint by default',
          value: onOff(s.stealth.fingerprint),
          hint: 'Coherent screen and window geometry per session. On by default with --stealth max. Set with --fingerprint.',
          configKey: 'fingerprint',
        },
        {
          label: 'Humanize by default',
          value: onOff(s.stealth.humanize),
          hint: 'Human-like mouse paths and typing rhythm for input tools. Slower, and needs stealth on. Set with --humanize.',
          configKey: 'humanize',
        },
        {
          label: 'CAPTCHA handling',
          value: s.stealth.captcha,
          ...(s.stealth.captcha === 'solver' && { tone: 'warn' as const }),
          hint: 'attention hands the browser to a human when a CAPTCHA appears; off does nothing. Set with --captcha.',
          configKey: 'captcha',
        },
      ],
    },
    {
      id: 'integrations',
      title: 'Integrations',
      rows: [
        {
          label: 'Vault',
          value: s.vault.enabled ? (s.vault.backend ?? 'On') : 'Off',
          hint: 'Credential injection for vault_fill: the agent names an entry, the password never reaches the model. Set with --vault.',
          configKey: 'vault',
        },
        {
          label: 'Telemetry',
          value: s.otel.enabled
            ? `OTLP${s.otel.endpoint !== null ? ` → ${s.otel.endpoint}` : ''}${s.otel.protocol !== null ? ` (${s.otel.protocol})` : ''}`
            : 'Off',
          hint: 'OpenTelemetry export of traces, metrics and logs. Off by default; nothing leaves this machine unless it is on. Set with --otel.',
          configKey: 'otel',
        },
      ],
    },
  ];
}

/**
 * Evidence that a browser launches even though `/system` reports no Chromium version: sessions are
 * running, or the health browser check passes. The daemon's version probe can miss the driver's own
 * bundled browser, so a warning there would contradict the running sessions.
 */
export function browserLaunches(s: SystemInfo, health: HealthResponse | undefined): boolean {
  return s.capacity.live > 0 || health?.checks.browser === 'ok';
}

/** Runtime versions; a missing browser engine is a problem with a fix only when nothing launches. */
export function runtimeRows(
  s: SystemInfo,
  health?: HealthResponse | undefined,
): readonly SettingRow[] {
  return [
    { label: 'Bun', value: s.runtime.bun },
    { label: 'SQLite', value: s.runtime.sqlite },
    { label: 'Playwright', value: s.runtime.playwright },
    s.runtime.patchright === null
      ? {
          label: 'Patchright',
          value: 'Not installed',
          tone: 'warn',
          fix: 'Stealth sessions fall back to stock Playwright. Install the optional patchright package to hide the CDP leak.',
        }
      : { label: 'Patchright', value: s.runtime.patchright },
    s.runtime.chromium !== null
      ? { label: 'Chromium', value: s.runtime.chromium }
      : browserLaunches(s, health)
        ? {
            label: 'Chromium',
            value: 'Available, version not reported',
            muted: true,
            hint: `Sessions launch, so ${s.stealth.driver === 'patchright' ? 'Patchright' : 'Playwright'} found a browser (its bundled Chromium or an installed Chrome channel), but the daemon could not read its version. Run browserhive init only if a launch fails with BROWSER_NOT_INSTALLED.`,
          }
        : {
            label: 'Chromium',
            value: 'Not installed',
            tone: 'warn',
            fix: 'Run browserhive init to download Chromium, or launch sessions on an installed Chrome channel.',
          },
  ];
}

/** KPI tiles: live metrics only. */
export function kpis(s: SystemInfo) {
  const ratio = dbRatio(s);
  return {
    sessions: {
      value: `${formatNumber(s.capacity.live)}${s.capacity.max === null ? '' : ` / ${formatNumber(s.capacity.max)}`}`,
      sub: s.capacity.max === null ? 'live · no cap' : 'live of max',
    },
    attention: {
      value: formatNumber(s.open_attention),
      tone: s.open_attention > 0 ? ('warn' as const) : undefined,
    },
    connections: {
      value: formatNumber(s.mcp.connections),
      dashboards: `${formatNumber(s.realtime.connections)} ${s.realtime.connections === 1 ? 'dashboard' : 'dashboards'}`,
      liveViews: `${formatNumber(s.active_screencasts)} live ${s.active_screencasts === 1 ? 'view' : 'views'}`,
    },
    database: {
      value: formatBytes(s.storage.db_bytes),
      sub:
        s.retention.bytes > 0
          ? `${formatPercent(ratio)} of ${formatBytes(s.retention.bytes)} cap`
          : 'no byte cap',
      tone: ratio >= DISK_WARN ? diskTone(ratio) : undefined,
    },
  };
}

/** Health for display: a successful body, or the degraded body a 503 carries. */
export function readHealth(data: unknown, error: unknown): HealthResponse | undefined {
  if (data !== undefined) {
    const parsed = HealthResponse.safeParse(data);
    if (parsed.success) return parsed.data;
  }
  if (isAppError(error) && error.status === 503) {
    const parsed = HealthResponse.safeParse(error.details['body']);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

/** Tone and label of the overall health status. */
export function healthTone(status: HealthResponse['status']): {
  readonly tone: Tone;
  readonly label: string;
} {
  switch (status) {
    case 'ready':
      return { tone: 'success', label: 'Ready' };
    case 'degraded':
      return { tone: 'warn', label: 'Degraded' };
    case 'starting':
      return { tone: 'info', label: 'Starting' };
    default:
      return { tone: 'neutral', label: 'Stopping' };
  }
}

/** Tone and label of one readiness check. */
export function checkTone(check: string): { readonly tone: Tone; readonly label: string } {
  switch (check) {
    case 'ok':
      return { tone: 'success', label: 'OK' };
    case 'degraded':
      return { tone: 'warn', label: 'Degraded' };
    case 'failed':
      return { tone: 'danger', label: 'Failed' };
    default:
      return { tone: 'neutral', label: 'Pending' };
  }
}

/** Page notices shown once at the top of Status, most severe first. */
export function systemNotices(
  s: SystemInfo,
  health: HealthResponse | undefined,
): readonly {
  readonly id: string;
  readonly tone: Tone;
  readonly title: string;
  readonly body: string;
}[] {
  const out: { id: string; tone: Tone; title: string; body: string }[] = [];
  if (evaluateRisky(s))
    out.push({
      id: 'evaluate',
      tone: 'danger',
      title: 'Evaluate is enabled while the vault is in use',
      body: 'A credential filled by vault_fill is readable by page scripts unless a session opts out. Disable --allowEvaluate unless you need arbitrary scripting.',
    });
  if (health !== undefined && health.status === 'degraded')
    out.push({
      id: 'degraded',
      tone: 'warn',
      title: 'The daemon is degraded',
      body: 'Some checks are failing. The open degradations below say what broke and since when.',
    });
  if (s.retention.bytes > 0 && dbRatio(s) > DISK_WARN)
    out.push({
      id: 'disk',
      tone: 'warn',
      title: 'Database close to its size cap',
      body: 'Older events will be pruned to stay under the limit.',
    });
  return out;
}

/** One browser channel on the System page. */
export interface BrowserRow {
  readonly channel: string;
  readonly label: string;
  readonly isDefault: boolean;
  readonly installed: boolean;
  /** `bundled` or `installed`. */
  readonly source: string;
  readonly version: string | null;
  readonly path: string | null;
  /** Sandbox verdict for an installed browser, or null when it is not installed. */
  readonly sandbox: { readonly label: string; readonly tone: Tone } | null;
  /** Chrome's own reason when the sandbox is unavailable. */
  readonly reason: string | null;
}

/**
 * The browsers the daemon found and each one's sandbox verdict. `unknown` becomes "not checked yet"
 * under `auto` (decided on the first launch) and "sandbox off" under `off`.
 *
 * @returns Rows (default channel first), or null for a daemon that does not report browsers.
 */
export function browserRows(s: SystemInfo): readonly BrowserRow[] | null {
  const b = s.browser;
  if (b === undefined) return null;
  const rows = b.channels.map((c): BrowserRow => {
    let sandbox: BrowserRow['sandbox'] = null;
    if (c.installed) {
      if (c.sandbox === 'sandboxed') sandbox = { label: 'sandboxed', tone: 'success' };
      else if (c.sandbox === 'unavailable')
        sandbox = {
          label: b.sandbox_mode === 'auto' ? 'falls back: no sandbox' : 'cannot sandbox here',
          tone: 'warn',
        };
      else if (b.running_as_root) sandbox = { label: 'no sandbox as root', tone: 'warn' };
      else if (b.sandbox_mode === 'off') sandbox = { label: 'sandbox off', tone: 'muted' };
      else sandbox = { label: 'not checked yet', tone: 'muted' };
    }
    return {
      channel: c.channel,
      label: c.label,
      isDefault: c.channel === b.default_channel,
      installed: c.installed,
      source: c.source,
      version: c.version,
      path: c.executable,
      sandbox,
      reason: c.sandbox_reason,
    };
  });
  return [...rows].sort((x, y) => Number(y.isDefault) - Number(x.isDefault));
}

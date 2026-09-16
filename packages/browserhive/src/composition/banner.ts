/** @module composition/banner — the startup banner (spec 08 §8): pure rendering from boot facts; printed once through `output` in the `ready` phase, never logged. */

import pc from 'picocolors';

/** Everything the banner shows. */
export interface BannerFacts {
  readonly version: string;
  readonly bunVersion: string;
  /** Resolved driver and its package version. */
  readonly driver: { readonly name: 'patchright' | 'playwright'; readonly version: string | null };
  readonly transport: 'http' | 'stdio';
  /** `http://host:port` (http only). */
  readonly url: string | null;
  readonly auth: 'off' | 'token';
  readonly admin: boolean;
  readonly dataDir: string;
  readonly db: {
    readonly schemaVersion: number;
    readonly sizeBytes: number;
    readonly backups: number;
  };
  /** `configSourceSummary` text. */
  readonly configSummary: string;
  readonly sessions: {
    readonly cap: number | 'unbounded';
    /** Host RAM in GiB when the cap was derived from it. */
    readonly derivedFromGib: number | null;
    /** Canonical lease rendering (`2h`). */
    readonly lease: string;
    readonly persistence: string;
  };
  readonly stealth: {
    readonly level: string;
    readonly humanize: boolean;
    readonly fingerprint: boolean;
  };
  readonly telemetry: { readonly endpoint: string; readonly protocol: string } | null;
  readonly vault: { readonly backend: 'off' | 'bitwarden'; readonly unlocked: boolean };
  readonly shadowLines: readonly string[];
  /** Resolver warnings (insecure bind acknowledged…), rendered as a red block. */
  readonly warnings: readonly string[];
  readonly adminPassword: { readonly password: string; readonly path: string } | null;
  readonly agentToken: { readonly principalId: string; readonly token: string } | null;
  /** Browser binary missing (degraded, not fatal). */
  readonly browserMissing: boolean;
}

/** Label column width (`Dashboard` + gap). */
const LABEL_WIDTH = 10;
/** Value column width before the parenthesised note. */
const VALUE_WIDTH = 36;

/** `2.0 MiB`-style size without a dependency on core formatting. */
export function formatMib(bytes: number): string {
  const mib = bytes / 1024 ** 2;
  return mib >= 10 ? `${Math.round(mib)} MiB` : `${Math.max(0, mib).toFixed(1)} MiB`;
}

/** Renders the banner lines (no trailing newline per line). */
export function renderBanner(facts: BannerFacts, options: { readonly color: boolean }): string[] {
  const c = pc.createColors(options.color);
  const driver = `${facts.driver.name}${facts.driver.version === null ? '' : ` ${facts.driver.version}`}`;
  const title = ` ${c.bold(`BrowserHive ${facts.version}`)}  ·  bun ${facts.bunVersion}  ·  ${driver}`;
  if (facts.transport === 'stdio') {
    return [
      `${title}  ·  stdio`,
      ` ${c.dim('Data dir')}  ${facts.dataDir}  (db v${facts.db.schemaVersion})`,
    ];
  }
  const row = (label: string, value: string, note?: string): string => {
    const head = ` ${c.dim(label.padEnd(LABEL_WIDTH))} `;
    return note === undefined
      ? `${head}${value}`
      : `${head}${value.padEnd(VALUE_WIDTH)} ${c.dim(`(${note})`)}`;
  };
  const url = facts.url ?? '';
  const lines = [title, row('MCP', c.cyan(`${url}/mcp`), `auth: ${facts.auth}`)];
  if (facts.admin) lines.push(row('Dashboard', c.cyan(`${url}/`), 'admin'));
  const backups = `${facts.db.backups} backup${facts.db.backups === 1 ? '' : 's'}`;
  lines.push(
    row(
      'Data dir',
      facts.dataDir,
      `db v${facts.db.schemaVersion}, ${formatMib(facts.db.sizeBytes)}, ${backups}`,
    ),
  );
  lines.push(row('Config', facts.configSummary));
  const cap =
    facts.sessions.derivedFromGib === null
      ? `cap ${facts.sessions.cap}`
      : `cap ${facts.sessions.cap} (derived from ${facts.sessions.derivedFromGib} GiB RAM)`;
  lines.push(
    row(
      'Sessions',
      `${cap} · lease ${facts.sessions.lease} · persistence ${facts.sessions.persistence}`,
    ),
  );
  lines.push(
    row(
      'Stealth',
      `${facts.stealth.level} · ${facts.driver.name} · humanize ${onOff(facts.stealth.humanize)} · fingerprint ${onOff(facts.stealth.fingerprint)}`,
    ),
  );
  lines.push(
    row(
      'Telemetry',
      facts.telemetry === null
        ? 'off'
        : `otel → ${facts.telemetry.endpoint} (${facts.telemetry.protocol})`,
    ),
  );
  lines.push(
    row(
      'Vault',
      facts.vault.backend === 'off'
        ? 'off'
        : `${facts.vault.backend} (${facts.vault.unlocked ? 'unlocked' : 'locked'})`,
    ),
  );
  const notes: string[] = [];
  for (const line of facts.shadowLines) notes.push(` ${line}`);
  if (facts.browserMissing) {
    notes.push(
      ` ${c.yellow('browser:')} Chromium is not installed; run 'browserhive init' before launching sessions.`,
    );
  }
  if (facts.adminPassword !== null) {
    notes.push(
      ` ${c.yellow('admin:')}  first-run password: ${c.bold(facts.adminPassword.password)}  (also in ${facts.adminPassword.path})`,
    );
  }
  if (facts.agentToken !== null) {
    notes.push(
      ` ${c.yellow('agent:')}  bearer token for principal ${facts.agentToken.principalId}: ${c.bold(facts.agentToken.token)}  (saved to the database; shown once)`,
    );
  }
  for (const warning of facts.warnings) notes.push(c.red(` ! ${warning}`));
  if (notes.length > 0) lines.push('', ...notes);
  lines.push(' Press Ctrl-C to stop.');
  return lines;
}

function onOff(value: boolean): string {
  return value ? 'on' : 'off';
}

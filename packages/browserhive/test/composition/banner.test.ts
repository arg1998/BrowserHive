/** @module test/composition/banner.test — the spec 08 §8 banner with colours off and fixed facts. */

import { describe, expect, it } from 'bun:test';
import { type BannerFacts, renderBanner } from '../../src/composition/index.ts';

const FACTS: BannerFacts = {
  version: '0.1.0',
  bunVersion: '1.4.2',
  driver: { name: 'patchright', version: '1.63.0' },
  transport: 'http',
  url: 'http://127.0.0.1:9876',
  auth: 'token',
  admin: true,
  dataDir: '/home/me/.local/share/browserhive',
  db: { schemaVersion: 7, sizeBytes: 12 * 1024 ** 2, backups: 3 },
  configSummary: 'env:2  file:/home/me/browserhive.config.json:9  cli:1',
  sessions: { cap: 8, derivedFromGib: 12, lease: '2h', persistence: 'memory' },
  stealth: { level: 'standard', humanize: true, fingerprint: false },
  telemetry: { endpoint: 'http://127.0.0.1:4318', protocol: 'http/protobuf' },
  vault: { backend: 'bitwarden', unlocked: false },
  shadowLines: ['config: maxSessions=8 (cli) shadows config-file=4'],
  warnings: [],
  adminPassword: {
    password: 'Kq7aaaaaaaaaaaaaaaaaaaaa',
    path: '/home/me/.local/share/browserhive/admin/credentials.txt',
  },
  agentToken: { principalId: 'agent-1', token: 'bh_agent_mT4' },
  browserMissing: false,
};

describe('renderBanner', () => {
  it('renders the http banner (colors off)', () => {
    expect(renderBanner(FACTS, { color: false })).toEqual([
      ' BrowserHive 0.1.0  ·  bun 1.4.2  ·  patchright 1.63.0',
      ' MCP        http://127.0.0.1:9876/mcp            (auth: token)',
      ' Dashboard  http://127.0.0.1:9876/               (admin)',
      ' Data dir   /home/me/.local/share/browserhive    (db v7, 12 MiB, 3 backups)',
      ' Config     env:2  file:/home/me/browserhive.config.json:9  cli:1',
      ' Sessions   cap 8 (derived from 12 GiB RAM) · lease 2h · persistence memory',
      ' Stealth    standard · patchright · humanize on · fingerprint off',
      ' Telemetry  otel → http://127.0.0.1:4318 (http/protobuf)',
      ' Vault      bitwarden (locked)',
      '',
      ' config: maxSessions=8 (cli) shadows config-file=4',
      ' admin:  first-run password: Kq7aaaaaaaaaaaaaaaaaaaaa  (also in /home/me/.local/share/browserhive/admin/credentials.txt)',
      ' agent:  bearer token for principal agent-1: bh_agent_mT4  (saved to the database; shown once)',
      ' Press Ctrl-C to stop.',
    ]);
  });

  it('omits the dashboard without admin and prints no secrets block after first start', () => {
    const lines = renderBanner(
      {
        ...FACTS,
        admin: false,
        adminPassword: null,
        agentToken: null,
        shadowLines: [],
        telemetry: null,
      },
      { color: false },
    );
    expect(lines.some((l) => l.startsWith(' Dashboard'))).toBe(false);
    expect(lines).toContain(' Telemetry  off');
    expect(lines.at(-2)).toBe(' Vault      bitwarden (locked)');
    expect(lines.at(-1)).toBe(' Press Ctrl-C to stop.');
  });

  it('is two lines under stdio and colors only when asked', () => {
    const stdio = renderBanner({ ...FACTS, transport: 'stdio', url: null }, { color: false });
    expect(stdio).toEqual([
      ' BrowserHive 0.1.0  ·  bun 1.4.2  ·  patchright 1.63.0  ·  stdio',
      ' Data dir  /home/me/.local/share/browserhive  (db v7)',
    ]);
    expect(renderBanner(FACTS, { color: true }).join('\n')).toContain('\x1b[');
    expect(renderBanner(FACTS, { color: false }).join('\n')).not.toContain('\x1b[');
  });

  it('prints reference provenance and reference warnings as notes (spec 08 §1, §3.1)', () => {
    const lines = renderBanner(
      {
        ...FACTS,
        shadowLines: [
          'config: otelHeaders=<redacted> (config-file via $OTLP_TOKEN) shadows env(otel)=<redacted>',
        ],
        warnings: [
          "BROWSERHIVE_OTEL_ENDPOINT contains '{env:OTLP_HOST}'; references are expanded only in browserhive.config.json.",
        ],
        adminPassword: null,
        agentToken: null,
      },
      { color: false },
    );
    expect(lines.slice(-4)).toEqual([
      '',
      ' config: otelHeaders=<redacted> (config-file via $OTLP_TOKEN) shadows env(otel)=<redacted>',
      " ! BROWSERHIVE_OTEL_ENDPOINT contains '{env:OTLP_HOST}'; references are expanded only in browserhive.config.json.",
      ' Press Ctrl-C to stop.',
    ]);
  });

  it('warns in the notes block when Chromium is missing', () => {
    const lines = renderBanner({ ...FACTS, browserMissing: true }, { color: false });
    expect(lines.join('\n')).toContain("run 'browserhive init' before launching sessions");
  });
});

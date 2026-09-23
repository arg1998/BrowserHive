/** @module scripts/gen-docs/configuration — renders docs/reference/configuration.md from the contracts key registry */
import {
  CONFIG_GROUPS,
  CONFIG_KEYS,
  type ConfigGroup,
  type ConfigKey,
  type DerivedSource,
  type KeyMeta,
  keyMeta,
  keysInGroup,
  namesFor,
  RESERVED_CONFIG_KEYS,
  RESERVED_ENUM_MEMBERS,
} from '@browserhive/contracts/config';
import { anchor, document, GENERATED_HEADER, inlineCode, jsonValue, table } from './markdown.ts';

const GROUP_TITLES: Readonly<Record<ConfigGroup, string>> = {
  server: 'Server',
  sessions: 'Sessions',
  stealth: 'Stealth',
  logging: 'Logging',
  recording: 'Recording and retention',
  telemetry: 'Telemetry',
};

const DERIVED_TEXT: Readonly<Record<DerivedSource, string>> = {
  hostMemory:
    'derived from available RAM: `min(floor(RAM_GiB / 1.5), 20)`, where RAM is host RAM capped by the cgroup memory limit on Linux',
  platform:
    'derived from the OS: `~/Library/Application Support/BrowserHive` (macOS), `%LOCALAPPDATA%\\BrowserHive` (Windows), `$XDG_DATA_HOME/browserhive` or `~/.local/share/browserhive` (Linux)',
  stealth: 'derived from `stealth`: `true` when `stealth=max`, otherwise `false`',
  admin: 'derived from `admin`: same value',
};

/** Standard OpenTelemetry variables read below `BROWSERHIVE_*` (spec 10 §8; `OTEL_ENV_KEYS` in core). */
const OTEL_ENV: readonly (readonly [string, ConfigKey])[] = [
  ['OTEL_EXPORTER_OTLP_ENDPOINT', 'otelEndpoint'],
  ['OTEL_EXPORTER_OTLP_HEADERS', 'otelHeaders'],
  ['OTEL_EXPORTER_OTLP_PROTOCOL', 'otelProtocol'],
  ['OTEL_SERVICE_NAME', 'otelServiceName'],
  ['OTEL_TRACES_SAMPLER_ARG', 'otelSampleRatio'],
];

/** Cross-field rules, exact texts of spec 08 §4.1 (enforced by `crossFieldIssues` in contracts). */
const CROSS_FIELD_RULES: readonly string[] = [
  '`minAttentionWait` must be less than `attentionTimeout` when it is greater than 0.',
  '`humanize=true` requires `stealth` to be `standard` or `max`.',
  '`fingerprint=true` (set explicitly) requires `stealth` to be `standard` or `max`.',
  '`captcha=attention` (set explicitly) requires `admin=true` and `transport=http`.',
  '`admin=true` requires `transport=http` (`ADMIN_REQUIRES_HTTP`, exit 3).',
  '`auth=token` requires `transport=http`.',
  '`otelEndpoint`, `otelProtocol`, `otelHeaders`, `otelServiceName` and `otelSampleRatio` require `otel=true`.',
  '`trustedProxies` requires a non-loopback `host`.',
  '`screenshotTrace=true` requires `trace=true`.',
  '`blocklistWatch=true` requires `blocklist` to be set.',
  'A non-loopback `host` without `auth=token` and without `allowInsecureBind=true` is refused (`INSECURE_BIND_REFUSED`, exit 3).',
];

const GRAMMARS: readonly (readonly [string, string])[] = [
  [
    'boolean',
    '`true`, `false`, `1`, `0`, `yes`, `no` (case-insensitive). CLI: `--admin` means true, `--admin=false` or `--noAdmin` sets false; `--admin false` is not accepted.',
  ],
  ['duration', 'integer plus `ms`, `s`, `m`, `h` or `d`; a bare integer is milliseconds.'],
  ['bytes', 'integer plus `B`, `KiB`, `MiB`, `GiB`, `KB`, `MB` or `GB`; a bare integer is bytes.'],
  ['integer / port', 'decimal integer, range-checked per key; ports are 1–65535.'],
  ['host', 'IPv4 literal, IPv6 literal (with or without brackets) or an RFC 1123 hostname.'],
  ['enum', 'exact member, case-sensitive.'],
  [
    'path',
    'relative paths resolve against the working directory (CLI, env) or the config file directory (file).',
  ],
  ['list', 'CLI/env: comma-separated, trimmed, no empty items. File: JSON array of strings.'],
  ['map', 'CLI/env: `k=v,k2=v2` (first `=` splits). File: JSON object of strings.'],
  ['url', 'absolute `http:` or `https:` URL.'],
];

function defaultText(meta: KeyMeta): string {
  if (meta.derivedFrom !== undefined) return DERIVED_TEXT[meta.derivedFrom];
  if (meta.defaultText !== undefined) return inlineCode(meta.defaultText);
  if (meta.default === undefined) return 'unset';
  if (Array.isArray(meta.default) && meta.default.length === 0) return 'empty list';
  if (typeof meta.default === 'string') return inlineCode(meta.default);
  return jsonValue(meta.default);
}

function shortDefault(meta: KeyMeta): string {
  if (meta.derivedFrom !== undefined) return `derived (${meta.derivedFrom})`;
  return defaultText(meta);
}

function markers(key: ConfigKey, meta: KeyMeta): string[] {
  const out: string[] = [];
  out.push(meta.restartRequired ? 'restart required' : 'runtime-adjustable');
  if (meta.secret) out.push('secret (rendered `<redacted>`)');
  if (meta.cliOnly) out.push('CLI and environment only (not accepted in the config file)');
  const reserved = RESERVED_ENUM_MEMBERS[key];
  if (reserved !== undefined) {
    out.push(`reserved values ${reserved.map(inlineCode).join(', ')} fail fast`);
  }
  return out;
}

function keySection(key: ConfigKey): string {
  const meta = keyMeta(key);
  const names = namesFor(key);
  const rows: string[][] = [
    ['CLI flag', inlineCode(names.cli)],
    ['Environment', inlineCode(names.env)],
    ['Config file', meta.cliOnly ? 'not accepted' : inlineCode(`"${names.json}"`)],
    ['Type', meta.grammar ?? 'string'],
    ['Default', defaultText(meta)],
  ];
  if (meta.examples !== undefined && meta.examples.length > 0) {
    rows.push(['Examples', meta.examples.map(inlineCode).join(', ')]);
  }
  rows.push(['Notes', markers(key, meta).join(' · ')]);
  return [
    anchor(key),
    `### ${inlineCode(key)}`,
    '',
    meta.describe,
    '',
    table(['Property', 'Value'], rows),
  ].join('\n');
}

function groupSection(group: ConfigGroup): string {
  const keys = keysInGroup(group);
  const index = table(
    ['Key', 'CLI', 'Environment', 'Default'],
    keys.map((key) => {
      const names = namesFor(key);
      return [
        `[${inlineCode(key)}](#${key})`,
        inlineCode(names.cli),
        inlineCode(names.env),
        shortDefault(keyMeta(key)),
      ];
    }),
  );
  return [`## ${GROUP_TITLES[group]}`, '', index, '', keys.map(keySection).join('\n\n')].join('\n');
}

/**
 * Render `docs/reference/configuration.md`.
 *
 * @returns The Markdown document.
 */
export function renderConfiguration(): string {
  const example = namesFor('maxSessions');
  return document([
    GENERATED_HEADER,
    '# Configuration reference',
    `Every configuration key of BrowserHive (${CONFIG_KEYS.length} keys), generated from the zod schema in \`@browserhive/contracts/config\`. For a guided introduction see [the configuration guide](../guide/configuration.md).`,
    '## Precedence',
    'Four sources, lowest to highest precedence. **Rightmost wins.**',
    '```\ndefaults  <  environment (BROWSERHIVE_*)  <  browserhive.config.json  <  CLI flags\n```',
    'Standard `OTEL_*` variables are read as a sub-source just below `BROWSERHIVE_*` (provenance `env(otel)`). When a key is supplied by more than one source, startup logs one line per key naming the winner and what it shadowed; secret values render as `<redacted>`:',
    '```\nconfig: maxSessions=8 (cli) shadows config-file=4, env=2\nconfig: logLevel=debug (config-file) shadows env=info\nconfig: authTokens=<redacted> (cli) shadows env=<redacted>\n```',
    'The same provenance is shown by `browserhive config show`, the System page of the dashboard and `GET /api/v1/system/config`. An empty value in the environment or the config file is a usage error, not "unset".',
    '## Naming',
    `Every key has one camelCase name. The other spellings are mechanical: \`${example.cli}\`, \`${example.env}\`, \`"${example.json}"\`. CLI flags are case-sensitive; kebab-case flags are unknown and fail with a "did you mean" hint. Unknown flags, environment variables and file keys stop startup with exit code 64.`,
    table(
      ['Canonical key', 'CLI flag', 'Environment variable', 'Config file key'],
      (['maxSessions', 'otelEndpoint', 'allowInsecureBind'] as const).map((key) => {
        const names = namesFor(key);
        return [
          inlineCode(key),
          inlineCode(names.cli),
          inlineCode(names.env),
          inlineCode(`"${names.json}"`),
        ];
      }),
    ),
    '## Config file discovery',
    'First hit wins: `--config <path>` (or `BROWSERHIVE_CONFIG`), then `./browserhive.config.json`, then `<dataDir>/browserhive.config.json`. The file is plain JSON; `"$schema"` is the only extra key tolerated. A config file found inside the data directory may not set `dataDir`. The JSON Schema is [config.schema.json](config.schema.json) (also printed by `browserhive config schema`).',
    '## Value grammars',
    table(['Grammar', 'Accepted forms'], GRAMMARS),
    '## OpenTelemetry environment variables',
    table(
      ['Variable', 'Key'],
      OTEL_ENV.map(([name, key]) => [inlineCode(name), `[${inlineCode(key)}](#${key})`]),
    ),
    '## Cross-field rules',
    'Checked after all sources are merged. Violations exit with code 64 unless noted.',
    CROSS_FIELD_RULES.map((rule, i) => `${i + 1}. ${rule}`).join('\n'),
    '## Reserved keys',
    `These names are reserved for future releases. Setting any of them fails fast with a "reserved" message: ${RESERVED_CONFIG_KEYS.map(inlineCode).join(', ')}.`,
    ...CONFIG_GROUPS.map(groupSection),
  ]);
}

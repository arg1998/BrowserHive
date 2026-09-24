/** @module test/cli/config — `config show` (provenance table, `--json` view), `config schema`, `config validate` */
import { describe, expect, it } from 'bun:test';
import {
  CONFIG_KEYS,
  configFileJsonSchema,
  serverConfigSchema,
} from '@browserhive/contracts/config';
import Ajv2020 from 'ajv/dist/2020.js';
import { z } from 'zod';
import { cliHarness, MemoryFs } from './helpers.ts';

const TOKEN = 'ci-runner:0123456789abcdef0123456789abcdef';

const Ref = z.strictObject({
  scheme: z.literal('env'),
  ref: z.string(),
  from: z.enum(['value', 'default']),
  at: z.string().optional(),
});
const ViewEntry = z.strictObject({
  value: z.unknown(),
  source: z.enum(['default', 'env', 'env(otel)', 'file', 'cli', 'derived']),
  derivedFrom: z.string().optional(),
  location: z.string().optional(),
  refs: z.array(Ref).optional(),
  template: z.string().optional(),
  shadowed: z.array(
    z.strictObject({
      source: z.string(),
      value: z.string(),
      location: z.string(),
      refs: z.array(Ref).optional(),
    }),
  ),
  restartRequired: z.boolean(),
});
/** A low-entropy sentinel secret (gitleaks scans every commit). */
const SENTINEL = 's'.repeat(40);

describe('config show', () => {
  it('prints the provenance table with sources and shadowed values', async () => {
    const fs = new MemoryFs({
      '/work/browserhive.config.json': JSON.stringify({ maxSessions: 4 }),
    });
    const run = await cliHarness({
      argv: ['config', 'show', '--maxSessions', '8', '--authTokens', TOKEN],
      env: { BROWSERHIVE_MAX_SESSIONS: '2' },
      fs,
    });
    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/^KEY\s+VALUE\s+SOURCE\s+SHADOWED$/m);
    expect(run.stdout).toMatch(/^maxSessions\s+8\s+cli\s+config-file=4, env=2$/m);
    expect(run.stdout).toMatch(/^authTokens\s+<redacted>\s+cli/m);
    expect(run.stdout).not.toContain('0123456789abcdef');
    expect(run.stdout).toMatch(/^port\s+9876\s+default/m);
    expect(run.stdout).toMatch(/^dataDir\s+\S+\s+derived \(platform\)/m);
    expect(run.stdout).toContain('Config file: /work/browserhive.config.json');
  });

  it('bare `config` is `config show`', async () => {
    const run = await cliHarness({ argv: ['config'] });
    expect(run.stdout).toMatch(/^KEY\s+VALUE/m);
  });

  it('--json: every key with value, source and shadowed; secrets redacted; values parse with the schema', async () => {
    const run = await cliHarness({
      argv: ['config', 'show', '--json', '--authTokens', TOKEN, '--port', '9000'],
    });
    expect(run.code).toBe(0);
    const view = z.record(z.string(), ViewEntry).parse(JSON.parse(run.stdout));
    expect(Object.keys(view).sort()).toEqual([...CONFIG_KEYS].sort());
    expect(view['authTokens']?.value).toEqual({ redacted: true });
    expect(view['port']).toMatchObject({ value: 9000, source: 'cli' });
    // The shown values, written back as a config file, are valid against the published JSON Schema
    // and parse with the zod schema (secrets swapped for a real value; `config` is CLI-only).
    const values: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(view)) {
      if (key === 'config' || entry.value === null) continue;
      values[key] = key === 'authTokens' ? [TOKEN] : key === 'otelHeaders' ? {} : entry.value;
    }
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const validate = ajv.compile(configFileJsonSchema());
    expect(validate(values) ? [] : validate.errors).toEqual([]);
    expect(serverConfigSchema.safeParse(values).error?.issues ?? []).toEqual([]);
  });

  it('an invalid configuration exits 64 with the resolver text', async () => {
    const run = await cliHarness({ argv: ['config', 'show', '--port', 'x'] });
    expect(run.code).toBe(64);
    expect(run.stderr).toContain("browserhive: invalid value for --port: 'x'.");
    expect(run.stdout).toBe('');
  });
});

describe('config show with references (spec 08 §3.1, §7.1)', () => {
  const fs = () =>
    new MemoryFs({
      '/work/browserhive.config.json': JSON.stringify({
        otel: true,
        otelEndpoint: 'http://{env:OTLP_HOST:-127.0.0.1}:4318',
        otelHeaders: { Authorization: 'Bearer {env:OTLP_TOKEN}' },
        authTokens: ['ci-runner:{env:CI_TOKEN}'],
        otelServiceName: '{env:GRAFANA_API_TOKEN}',
      }),
    });
  const env = {
    OTLP_TOKEN: SENTINEL,
    CI_TOKEN: SENTINEL,
    GRAFANA_API_TOKEN: SENTINEL,
    BROWSERHIVE_OTEL_ENDPOINT: 'http://127.0.0.1:4318',
  };

  it('names the variables in SOURCE and never prints a secret', async () => {
    const run = await cliHarness({ argv: ['config', 'show'], env, fs: fs() });
    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(
      /^otelEndpoint\s+http:\/\/127\.0\.0\.1:4318\s+config-file via \$OTLP_HOST \(default\)\s+env=http:\/\/127\.0\.0\.1:4318$/m,
    );
    expect(run.stdout).toMatch(/^otelHeaders\s+<redacted>\s+config-file via \$OTLP_TOKEN\s*$/m);
    expect(run.stdout).toMatch(/^authTokens\s+<redacted>\s+config-file via \$CI_TOKEN\s*$/m);
    expect(run.stdout).toMatch(
      /^otelServiceName\s+<redacted>\s+config-file via \$GRAFANA_API_TOKEN\s*$/m,
    );
    expect(`${run.stdout}${run.stderr}`).not.toContain(SENTINEL);
  });

  it('--json carries refs, and a template only where the value is shown', async () => {
    const run = await cliHarness({ argv: ['config', 'show', '--json'], env, fs: fs() });
    expect(run.code).toBe(0);
    expect(run.stdout).not.toContain(SENTINEL);
    const view = z.record(z.string(), ViewEntry).parse(JSON.parse(run.stdout));
    expect(view['otelEndpoint']).toMatchObject({
      value: 'http://127.0.0.1:4318',
      source: 'file',
      refs: [{ scheme: 'env', ref: 'OTLP_HOST', from: 'default' }],
      template: 'http://{env:OTLP_HOST:-127.0.0.1}:4318',
      shadowed: [{ source: 'env', value: 'http://127.0.0.1:4318' }],
    });
    expect(view['otelHeaders']).toMatchObject({
      value: { redacted: true },
      refs: [{ scheme: 'env', ref: 'OTLP_TOKEN', from: 'value', at: 'Authorization' }],
    });
    for (const key of ['otelHeaders', 'authTokens', 'otelServiceName']) {
      expect(view[key]?.template).toBeUndefined();
    }
    expect(view['otelServiceName']?.value).toEqual({ redacted: true });
  });

  it('validate prints the shadow line with the variable, and warns about a reference outside the file', async () => {
    const run = await cliHarness({
      argv: ['config', 'validate', '--otelServiceName', '{env:NAME}'],
      env,
      fs: fs(),
    });
    expect(run.code).toBe(0);
    expect(run.stderr).toContain(
      "browserhive: warning: --otelServiceName contains '{env:NAME}'; references are expanded only in browserhive.config.json.",
    );
    expect(run.stderr).toContain(
      'config: otelEndpoint=http://127.0.0.1:4318 (config-file via $OTLP_HOST (default)) shadows env=http://127.0.0.1:4318',
    );
    expect(run.stderr).toContain(
      // One credential-looking name redacts the whole key for the run, the flag's value too.
      'config: otelServiceName=<redacted> (cli) shadows config-file=<redacted> via $GRAFANA_API_TOKEN',
    );
    expect(`${run.stdout}${run.stderr}`).not.toContain(SENTINEL);
  });

  it('an unset variable fails validate like serve, naming the variable only', async () => {
    const validate = await cliHarness({ argv: ['config', 'validate'], env: {}, fs: fs() });
    const serve = await cliHarness({ argv: [], env: {}, fs: fs() });
    expect(validate.code).toBe(64);
    expect(validate.stderr.split('\n').filter(Boolean)).toEqual([
      "browserhive: 'otelHeaders' in /work/browserhive.config.json references {env:OTLP_TOKEN}, but OTLP_TOKEN is not set. Set it, or write a default as {env:OTLP_TOKEN:-<value>}.",
      "browserhive: 'authTokens' in /work/browserhive.config.json references {env:CI_TOKEN}, but CI_TOKEN is not set. Set it, or write a default as {env:CI_TOKEN:-<value>}.",
      "browserhive: 'otelServiceName' in /work/browserhive.config.json references {env:GRAFANA_API_TOKEN}, but GRAFANA_API_TOKEN is not set. Set it, or write a default as {env:GRAFANA_API_TOKEN:-<value>}.",
    ]);
    expect(serve.stderr).toBe(validate.stderr);
  });
});

describe('config schema', () => {
  it('prints the JSON Schema of the config file', async () => {
    const run = await cliHarness({ argv: ['config', 'schema'] });
    expect(run.code).toBe(0);
    const printed: unknown = JSON.parse(run.stdout);
    expect(printed).toEqual(JSON.parse(JSON.stringify(configFileJsonSchema())));
    const schema = z
      .object({ properties: z.record(z.string(), z.object({}).passthrough()) })
      .passthrough()
      .parse(printed);
    for (const key of CONFIG_KEYS.filter((k) => k !== 'config')) {
      expect(Object.keys(schema.properties)).toContain(key);
    }
    expect(new Ajv2020({ strict: false }).validateSchema(schema)).toBe(true);
  });

  it('a reference is valid for every key in the published schema', async () => {
    const properties = z
      .object({ properties: z.record(z.string(), z.unknown()) })
      .parse(configFileJsonSchema()).properties;
    const withRefs = Object.fromEntries(
      Object.keys(properties)
        .filter((key) => key !== '$schema')
        .map((key) => [key, `{env:BH_${key.toUpperCase()}}`]),
    );
    const validate = new Ajv2020({ strict: false, allErrors: true }).compile(
      configFileJsonSchema(),
    );
    expect(validate(withRefs) ? [] : validate.errors).toEqual([]);
    expect(validate({ stealth: 'banana' })).toBe(false);
    expect(validate({ stealth: '{env:STEALTH:-max}' })).toBe(true);
  });

  it('a config file built from the schema property names resolves', async () => {
    const fs = new MemoryFs({
      '/work/browserhive.config.json': JSON.stringify({
        $schema: './browserhive.schema.json',
        port: 9001,
        sessionLease: '3h',
      }),
    });
    const run = await cliHarness({ argv: ['config', 'validate'], fs });
    expect(run.code).toBe(0);
  });
});

describe('config validate', () => {
  it('valid → exit 0 with the file and shadow lines on stderr', async () => {
    const fs = new MemoryFs({
      '/work/browserhive.config.json': JSON.stringify({ logLevel: 'debug' }),
    });
    const run = await cliHarness({
      argv: ['config', 'validate'],
      env: { BROWSERHIVE_LOG_LEVEL: 'info' },
      fs,
    });
    expect(run.code).toBe(0);
    expect(run.stdout).toBe('✓ configuration is valid  /work/browserhive.config.json\n');
    expect(run.stderr).toBe('config: logLevel=debug (config-file) shadows env=info\n');
  });

  it('invalid → exit 64 printing exactly what serve prints', async () => {
    const fs = new MemoryFs({ '/work/browserhive.config.json': JSON.stringify({ maxSession: 4 }) });
    const validate = await cliHarness({ argv: ['config', 'validate'], fs });
    const serve = await cliHarness({ argv: [], fs });
    expect(validate.code).toBe(64);
    expect(validate.stderr).toBe(
      "browserhive: unknown key 'maxSession' in /work/browserhive.config.json. Did you mean 'maxSessions'?\n",
    );
    expect(serve.code).toBe(64);
    expect(serve.stderr).toBe(validate.stderr);
  });
});

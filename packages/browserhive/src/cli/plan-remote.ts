/** @module cli/plan-remote — the REST commands (`channels`, `templates`, `admin tokens --url`): the `--url`/`--token`/`--cookie` target, falling back to the configured host and port */
import { PREVIEW_SAMPLES, PreviewSample } from '@browserhive/contracts/notifications';
import type { CliPlan, RemoteTarget } from './invocation.ts';
import type { FlagReader } from './plan-args.ts';
import { colorOf, failurePlan, type PlanInput, resolveFull, run, usage } from './plan-resolve.ts';
import { templatesInvocation } from './plan-templates.ts';
import { commandDescriptor } from './registry.ts';

/**
 * `--url` with `--token` or `--cookie`; the credentials without `--url` are usage problems.
 *
 * @returns The explicit target, or `null` without `--url`.
 */
export function remoteTarget(reader: FlagReader): RemoteTarget | null {
  const url = reader.url('url');
  const token = reader.text('token');
  const cookie = reader.text('cookie');
  if (url === undefined) {
    if (token !== undefined) reader.problems.push('--token requires --url.');
    if (cookie !== undefined) reader.problems.push('--cookie requires --url.');
    return null;
  }
  return { url, ...(token !== undefined && { token }), ...(cookie !== undefined && { cookie }) };
}

/** `--url` when given, else the configured host and port (a wildcard bind is reached on loopback). */
function remoteOrConfigured(input: PlanInput, explicit: RemoteTarget | null): RemoteTarget {
  if (explicit !== null) return explicit;
  const resolved = resolveFull(input);
  const host = resolved.ok ? resolved.value.config.host : '127.0.0.1';
  const port = resolved.ok ? resolved.value.config.port : 9876;
  const reachable = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  return { url: `http://${reachable.includes(':') ? `[${reachable}]` : reachable}:${port}` };
}

/**
 * Plans the `templates` subcommands: every one talks to a running server, except `rekey`, which
 * runs locally against the data directory (spec 13 §2.4, §11.5).
 *
 * @returns The plan.
 */
export function planTemplates(name: string, input: PlanInput): CliPlan {
  const { reader, color } = input;
  if (name === 'templates rekey') return planTemplatesRekey(input);
  const invocation = templatesInvocation(name, { ...input, cwd: input.context.cwd });
  const explicit = remoteTarget(reader);
  if (reader.problems.length > 0) return usage(reader.problems);
  // `--stealth` and `--proxy` of `templates create` are not the server keys of the same names.
  const flags = new Map([...input.tokens.flags].filter(([flag]) => !TEMPLATE_FLAGS.has(flag)));
  const remote = remoteOrConfigured({ ...input, tokens: { ...input.tokens, flags } }, explicit);
  return run(invocation(remote), color);
}

/**
 * `templates rekey --oldKeyEnv <ENV>`: the data directory and the current keys as `serve` resolves
 * them (the environment, the config file and its references). The old key is read from `<ENV>` when
 * the command runs, never from argv.
 */
function planTemplatesRekey(input: PlanInput): CliPlan {
  const { reader, color } = input;
  const json = reader.bool('json');
  const oldKeyEnv = reader.text('oldKeyEnv');
  if (oldKeyEnv === undefined) {
    reader.problems.push(
      "'templates rekey' requires --oldKeyEnv <ENV>: the name of the environment variable holding the old key.",
    );
  } else if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(oldKeyEnv)) {
    reader.problems.push(
      `invalid value for --oldKeyEnv: expected an environment variable name like BH_OLD_TEMPLATE_KEY, not the key itself.`,
    );
  }
  if (reader.problems.length > 0) return usage(reader.problems);
  const resolved = resolveFull(input);
  if (!resolved.ok) return failurePlan(resolved.error);
  const { config } = resolved.value;
  return run(
    {
      command: 'templates-rekey',
      dataDir: config.dataDir,
      oldKeyEnv: oldKeyEnv ?? '',
      templateKey: config.templateKey ?? null,
      templateKeyPrevious: config.templateKeyPrevious ?? null,
      json,
    },
    colorOf(resolved.value, color),
  );
}

const TEMPLATE_FLAGS: ReadonlySet<string> = new Set(
  commandDescriptor('templates').subcommands.flatMap((s) => s.flags.map((flag) => flag.name)),
);

/**
 * Plans `channels list | test | preview`.
 *
 * @returns The plan.
 */
export function planChannels(name: string, input: PlanInput): CliPlan {
  const { reader, color, args } = input;
  const json = reader.bool('json');
  const sampleText = reader.oneOf('sample', PREVIEW_SAMPLES) ?? 'attention';
  const explicit = remoteTarget(reader);
  if (reader.problems.length > 0) return usage(reader.problems);
  const remote = remoteOrConfigured(input, explicit);
  const sample = PreviewSample.parse(sampleText);
  const channel = args[0] ?? '';
  switch (name) {
    case 'channels list':
      return run({ command: 'channels-list', json, remote }, color);
    case 'channels test':
      return run({ command: 'channels-test', name: channel, json, remote }, color);
    default:
      return run({ command: 'channels-preview', name: channel, sample, json, remote }, color);
  }
}

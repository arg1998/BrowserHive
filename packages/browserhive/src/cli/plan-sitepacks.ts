/** @module cli/plan-sitepacks — the `sitepacks` subcommands' arguments and flags → one invocation, with the cheap local checks (pack id, version numbers, `follow`'s setting, `--source`, `--to`) as usage errors (spec 13 §11.5) */
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { PackRegistrableDomain } from '@browserhive/contracts/site-packs';
import type { CliPlan, SitePacksAction, SitePacksSource } from './invocation.ts';
import type { FlagReader } from './plan-args.ts';
import { remoteOrConfigured, remoteTarget } from './plan-remote.ts';
import { type PlanInput, run, usage } from './plan-resolve.ts';

const SOURCES: readonly SitePacksSource[] = ['local', 'registry', 'bundled', 'import'];
const FOLLOW_SETTINGS: ReadonlyMap<string, boolean | null> = new Map([
  ['on', true],
  ['off', false],
  ['auto', null],
]);

/**
 * Plans `sitepacks <subcommand>`: every subcommand talks to a running server.
 *
 * @returns The plan.
 */
export function planSitePacks(name: string, input: PlanInput): CliPlan {
  const { reader, color } = input;
  const json = reader.bool('json');
  if (name === 'sitepacks verify') {
    // Offline: no server, only the path (spec 13 §11.5).
    if (reader.problems.length > 0) return usage(reader.problems);
    const raw = input.args[0] ?? '';
    const path = isAbsolute(raw) ? raw : resolvePath(input.context.cwd, raw);
    return run({ command: 'sitepacks-verify', path, json }, color);
  }
  const action = sitePacksAction(name, input);
  const explicit = remoteTarget(reader);
  if (reader.problems.length > 0) return usage(reader.problems);
  const remote = remoteOrConfigured(input, explicit);
  return run({ command: 'sitepacks', action, json, remote }, color);
}

function sitePacksAction(name: string, input: PlanInput): SitePacksAction {
  const { reader, args } = input;
  const word = name.slice('sitepacks '.length);
  if (word === 'list') {
    return { kind: 'list', sources: sourceList(reader), pending: reader.bool('pending') };
  }
  if (word === 'reload') return { kind: 'reload' };
  if (word === 'import') {
    const raw = args[0] ?? '';
    return { kind: 'import', path: isAbsolute(raw) ? raw : resolvePath(input.context.cwd, raw) };
  }
  const packId = packIdArgument(reader, args[0] ?? '');
  switch (word) {
    case 'show':
      return { kind: 'show', packId };
    case 'diff':
      return { kind: 'diff', packId, to: toFlag(reader) };
    case 'apply':
      return {
        kind: 'apply',
        packId,
        version: optionalVersion(reader, args[1]),
        yes: reader.bool('yes'),
      };
    case 'reject':
      return { kind: 'reject', packId, version: optionalVersion(reader, args[1]) };
    case 'revert':
      return { kind: 'revert', packId, yes: reader.bool('yes') };
    case 'pin':
      return { kind: 'pin', packId, version: optionalVersion(reader, args[1]) ?? 1 };
    case 'unpin':
      return { kind: 'unpin', packId };
    case 'follow':
      return { kind: 'follow', packId, follow: followSetting(reader, args[1] ?? '') };
    case 'approve-local':
      return { kind: 'approve-local', packId, yes: reader.bool('yes') };
    case 'enable':
      return { kind: 'enable', packId };
    case 'disable':
      return { kind: 'disable', packId };
    default:
      reader.problems.push(`unsupported invocation '${name}'.`);
      return { kind: 'show', packId };
  }
}

/** `<id>`: a registrable domain, lower-cased. */
function packIdArgument(reader: FlagReader, raw: string): string {
  const id = raw.trim().toLowerCase();
  if (!PackRegistrableDomain.safeParse(id).success) {
    reader.problems.push(
      `invalid pack id '${raw}'. Expected the registrable domain the pack is for, like linkedin.com.`,
    );
  }
  return id;
}

/** A version argument: a positive whole number; `null` when absent. */
function optionalVersion(reader: FlagReader, raw: string | undefined): number | null {
  if (raw === undefined) return null;
  if (/^[1-9][0-9]{0,6}$/.test(raw)) return Number(raw);
  reader.problems.push(
    `invalid version '${raw}'. Expected a version number as listed by browserhive sitepacks show.`,
  );
  return null;
}

/** `--to <version|local>`; `null` when absent. */
function toFlag(reader: FlagReader): number | 'local' | null {
  const raw = reader.text('to');
  if (raw === undefined) return null;
  if (raw === 'local') return 'local';
  if (/^[1-9][0-9]{0,6}$/.test(raw)) return Number(raw);
  reader.problems.push(
    `invalid value for --to: '${raw}'. Expected a pending version number, or local.`,
  );
  return null;
}

/** `on | off | auto` of `follow`. */
function followSetting(reader: FlagReader, raw: string): boolean | null {
  const key = raw.toLowerCase();
  if (FOLLOW_SETTINGS.has(key)) return FOLLOW_SETTINGS.get(key) ?? null;
  reader.problems.push(
    `unknown setting '${raw}' for 'sitepacks follow'. Expected one of: on, off, auto.`,
  );
  return null;
}

/** `--source a,b`: comma-separated, de-duplicated sources; empty = every source. */
function sourceList(reader: FlagReader): readonly SitePacksSource[] {
  const raw = reader.text('source');
  if (raw === undefined) return [];
  const sources: SitePacksSource[] = [];
  for (const part of raw.split(',').map((value) => value.trim().toLowerCase())) {
    const found = SOURCES.find((source) => source === part);
    if (found === undefined) {
      reader.problems.push(
        `invalid value for --source: '${part}'. Expected one of: ${SOURCES.join(', ')}.`,
      );
    } else if (!sources.includes(found)) {
      sources.push(found);
    }
  }
  return sources;
}

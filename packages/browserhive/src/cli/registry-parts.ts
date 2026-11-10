/** @module cli/registry-parts — flag descriptors shared by several commands (`--json`, the `--url`/`--token`/`--cookie` remote target) and the `sub` subcommand builder used by the registry files */
import type { ConfigKey } from '@browserhive/contracts/config';
import type { ArgumentDescriptor, FlagDescriptor, SubcommandDescriptor } from './registry-types.ts';

/** `--json`. */
export const jsonFlag: FlagDescriptor = {
  name: 'json',
  kind: 'boolean',
  describe: 'Print machine-readable JSON instead of text.',
};

/** `--url`, `--token` and `--cookie`: a running server's REST API. */
export const remoteFlags: readonly FlagDescriptor[] = [
  {
    name: 'url',
    kind: 'value',
    placeholder: '<url>',
    describe:
      'Talk to a running server over its REST API instead of opening the database (http://127.0.0.1:9876).',
  },
  {
    name: 'token',
    kind: 'value',
    placeholder: '<bearer>',
    describe: 'Operator bearer token for --url (bh_operator_…).',
  },
  {
    name: 'cookie',
    kind: 'value',
    placeholder: '<value>',
    describe: 'Dashboard session cookie value for --url (browserhive_session).',
  },
];

/**
 * A subcommand descriptor with empty defaults.
 *
 * @returns The descriptor.
 */
export function sub(
  words: readonly string[],
  summary: string,
  options: {
    readonly args?: readonly ArgumentDescriptor[];
    readonly flags?: readonly FlagDescriptor[];
    readonly configKeys?: readonly ConfigKey[];
  } = {},
): SubcommandDescriptor {
  return {
    words,
    summary,
    args: options.args ?? [],
    flags: options.flags ?? [],
    configKeys: options.configKeys ?? [],
  };
}

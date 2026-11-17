/** @module cli/registry-sitepacks — the `sitepacks` command as registry data (spec 13 §11.5). `verify` checks a pack file offline; the commands that talk to a running server (`list`, `show`, `diff`, `apply`, …) join this list as further `sub(...)` entries. */

import { jsonFlag, sub } from './registry-parts.ts';
import type { CommandDescriptor } from './registry-types.ts';

/** `browserhive sitepacks …`. */
export const SITEPACKS_COMMAND: CommandDescriptor = {
  name: 'sitepacks',
  summary: 'Check and manage site packs',
  description:
    'Site packs describe how a template site signs in, how BrowserHive tells it is signed in, and which requests and controls are blocked or need confirmation. verify checks a pack file offline against the schema and its rules; it needs no server.',
  flags: [],
  configKeys: [],
  subcommands: [
    sub(['verify'], 'Check a site pack file offline (schema, refinements, size)', {
      args: [{ name: 'path', required: true, describe: 'The pack file (<pack id>.json).' }],
      flags: [jsonFlag],
    }),
  ],
  defaultSubcommand: null,
  args: [],
};

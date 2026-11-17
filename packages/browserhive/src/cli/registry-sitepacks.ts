/** @module cli/registry-sitepacks — the `sitepacks` command as registry data: list, show, diff, apply, reject, revert, pin, unpin, follow, approve-local, enable, disable, reload and import over a running server's REST API (spec 13 §9.6, §10.5, §10.6, §11.5) */

import { jsonFlag, remoteFlags, sub } from './registry-parts.ts';
import type { ArgumentDescriptor, CommandDescriptor, FlagDescriptor } from './registry-types.ts';

const packArg: ArgumentDescriptor = {
  name: 'pack',
  required: true,
  describe: 'The pack id: the registrable domain the pack is for (linkedin.com).',
};
const pendingVersionArg: ArgumentDescriptor = {
  name: 'version',
  required: false,
  describe:
    'A pending version number. Without it, the only pending version (an error when there are several or none).',
};
const yesFlag: FlagDescriptor = {
  name: 'yes',
  kind: 'boolean',
  describe: 'Skip the confirmation prompt (required without a terminal).',
};
const remoteJson: readonly FlagDescriptor[] = [jsonFlag, ...remoteFlags];

/** `list | show | diff`: reading the catalog. */
const readSubcommands = [
  sub(['list'], 'List site packs with their approved version, local file and pending updates', {
    flags: [
      {
        name: 'source',
        kind: 'value',
        placeholder: '<local|registry|bundled|import>',
        describe: 'Only packs from these sources, comma-separated.',
        defaultText: 'every source',
      },
      {
        name: 'pending',
        kind: 'boolean',
        describe:
          'Only packs with a pending update or a local file waiting for approval. Exits 2 when there is one.',
      },
      ...remoteJson,
    ],
  }),
  sub(['show'], 'Show a pack: approval and provenance, local file, pending versions, rules', {
    args: [packArg],
    flags: remoteJson,
  }),
  sub(['diff'], 'Show the field changes between the approved version and a candidate', {
    args: [packArg],
    flags: [
      {
        name: 'to',
        kind: 'value',
        placeholder: '<version|local>',
        describe: 'A pending version number, or local for the local file.',
        defaultText: 'the only pending version or local file waiting for approval',
      },
      ...remoteJson,
    ],
  }),
];

/** `apply | reject | revert | pin | unpin | follow | approve-local | enable | disable`: decisions. */
const decisionSubcommands = [
  sub(['apply'], 'Approve a pending version: every template using the pack follows it', {
    args: [packArg, pendingVersionArg],
    flags: [...remoteJson, yesFlag],
  }),
  sub(['reject'], 'Dismiss a pending version (a newer one appears again)', {
    args: [packArg, pendingVersionArg],
    flags: remoteJson,
  }),
  sub(['revert'], 'Go back to the previous approved version', {
    args: [packArg],
    flags: [...remoteJson, yesFlag],
  }),
  sub(['pin'], 'Keep a pack at its approved version; newer versions are listed, not offered', {
    args: [packArg, { name: 'version', required: true, describe: 'The approved version.' }],
    flags: remoteJson,
  }),
  sub(['unpin'], 'Stop pinning a pack', { args: [packArg], flags: remoteJson }),
  sub(['follow'], 'Choose whether a pack lists pending updates and notifies about them', {
    args: [
      packArg,
      {
        name: 'setting',
        required: true,
        describe: 'on, off, or auto (followed while a template uses the pack).',
      },
    ],
    flags: remoteJson,
  }),
  sub(['approve-local'], "Approve the local file's current content (prints its diff first)", {
    args: [packArg],
    flags: [...remoteJson, yesFlag],
  }),
  sub(['enable'], 'Enable a disabled pack', { args: [packArg], flags: remoteJson }),
  sub(['disable'], 'Disable a pack: its sites become generic, its rules stop applying', {
    args: [packArg],
    flags: remoteJson,
  }),
];

/** `reload | import`: the local folder. */
const localSubcommands = [
  sub(['reload'], 'Read the bundled packs and the local folder (sitePacksDir) again', {
    flags: remoteJson,
  }),
  sub(['import'], 'Copy an unsigned pack file into the local folder; approve it afterwards', {
    args: [
      {
        name: 'file',
        required: true,
        describe: 'One pack JSON file (≤ 1 MiB). Signed layouts arrive with a later release.',
      },
    ],
    flags: remoteJson,
  }),
  sub(['verify'], 'Check a site pack file offline (schema, refinements, size)', {
    args: [{ name: 'path', required: true, describe: 'The pack file (<pack id>.json).' }],
    flags: [jsonFlag],
  }),
];

/** `sitepacks`. */
export const SITEPACKS_COMMAND: CommandDescriptor = {
  name: 'sitepacks',
  summary: 'List, review, approve and manage site packs',
  description:
    'Talks to a running server over its REST API (--url, default the configured host and port) with an operator bearer (--token) or the dashboard cookie (--cookie). A pack applies only once an operator approved its version: adding a site to a template approves what it shows; later versions wait as pending updates until you apply them. Local files in sitePacksDir need approval once per content (SHA-256). apply, revert and approve-local ask for confirmation on a terminal and refuse without one unless --yes. list --pending exits 2 when an update or a local file waits for you.',
  flags: [],
  configKeys: ['host', 'port', 'config', 'color'],
  subcommands: [...readSubcommands, ...decisionSubcommands, ...localSubcommands],
  defaultSubcommand: ['list'],
  args: [],
};

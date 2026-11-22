/** @module cli/registry-sitepacks — the `sitepacks` command as registry data: list, show, check, download, diff, apply, reject, revert, pin, unpin, follow, approve-local, enable, disable, reload, import and export over a running server's REST API, and the offline verify (spec 13 §9.6, §10.4–§10.6, §11.5) */

import { jsonFlag, serverFlags, sub } from './registry-parts.ts';
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
const remoteJson: readonly FlagDescriptor[] = [jsonFlag, ...serverFlags];

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
  sub(
    ['show'],
    'Show a pack: approval, local file, classified pending versions, rules, strategies',
    {
      args: [packArg],
      flags: remoteJson,
    },
  ),
  sub(['check'], 'Check the online registry for new versions now (the signed index only)', {
    flags: remoteJson,
  }),
  sub(['download'], 'Download & review: fetch a listed version, verify it, show its diff', {
    args: [
      {
        name: 'pack',
        required: false,
        describe:
          'The pack id: the registrable domain the pack is for (linkedin.com). Omit it with --all.',
      },
      {
        name: 'version',
        required: false,
        describe:
          'A version the registry index lists. Without it, the pending available version, else the newest one this BrowserHive can use.',
      },
    ],
    flags: [
      {
        name: 'all',
        kind: 'boolean',
        describe:
          'Download every listed version this server lacks, for every pack, so the registry cannot tell which pack you care about.',
      },
      ...remoteJson,
    ],
  }),
  sub(['diff'], 'Show the classified field changes from the approved version to a candidate', {
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
    flags: [...remoteJson, yesFlag],
  }),
];

/** `reload | import | export | verify`: the local folder, signed layouts and offline checks. */
const localSubcommands = [
  sub(['reload'], 'Read the bundled packs and the local folder (sitePacksDir) again', {
    flags: remoteJson,
  }),
  sub(['import'], 'Import a signed registry layout, or one unsigned pack file, byte for byte', {
    args: [
      {
        name: 'path',
        required: true,
        describe:
          'A folder holding a signed layout (keys.json, index.json, their .sig files and packs/, as export writes): verified with the keys built into this release, its versions queued for review. Or one pack JSON file: stored in the local folder, approved afterwards with approve-local. At most 1 MiB.',
      },
    ],
    flags: remoteJson,
  }),
  sub(['export'], "Write the server's verified signed layout to a folder, for an offline host", {
    args: [
      {
        name: 'dir',
        required: true,
        describe:
          'The folder to write: new or empty, or one that already holds a layout (only its layout files are replaced).',
      },
    ],
    flags: remoteJson,
  }),
  sub(['verify'], 'Check a site pack file or a signed registry layout offline', {
    args: [
      {
        name: 'path',
        required: true,
        describe:
          'The pack file (<pack id>.json): schema, refinements, size. Or a folder holding a signed layout (keys.json, index.json, their .sig files and packs/): every signature against the root keys built into this release, and every pack file against the index.',
      },
    ],
    flags: [jsonFlag],
  }),
];

/** `sitepacks`. */
export const SITEPACKS_COMMAND: CommandDescriptor = {
  name: 'sitepacks',
  summary: 'List, review, approve and manage site packs',
  description:
    'Talks to a running server over its REST API (--url, default the configured host and port) with an operator bearer (--token) or the dashboard cookie (--cookie). A pack applies only once an operator approved its version: adding a site to a template approves what it shows; later versions wait as pending updates until you apply them. Registry versions are listed as available from the signed index; download fetches and verifies one so you can review its diff. Local files in sitePacksDir need approval once per content (SHA-256). apply, revert, approve-local and disable ask for confirmation on a terminal and refuse without one unless --yes. check and list --pending exit 2 when an update or a local file waits for you.',
  flags: [],
  configKeys: ['host', 'port', 'config', 'color'],
  subcommands: [...readSubcommands, ...decisionSubcommands, ...localSubcommands],
  defaultSubcommand: ['list'],
  args: [],
};

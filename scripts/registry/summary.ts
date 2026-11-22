/** @module scripts/registry/summary — the Markdown report of `registry-build.ts` for the job summary of a pull request (spec 13 §10.7, T4a acceptance): the registry's size and keys, each changed pack with its classification and classified fields, and every problem. */

import type { PackChange, RegistryCheck } from './check.ts';

/** Fields listed per pack before "and N more". */
const MAX_FIELDS = 15;

function cell(value: unknown): string {
  const text = value === undefined ? '—' : JSON.stringify(value);
  const short = text.length > 60 ? `${text.slice(0, 57)}…` : text;
  return `\`${short.replace(/`/g, "'").replace(/\|/g, '\\|')}\``;
}

function changeRows(change: PackChange): string[] {
  const head = `#### ${change.id}: ${change.from === null ? 'new' : `v${change.from}`} → ${change.to === null ? 'removed' : `v${change.to}`} — **${change.classification}**`;
  if (change.classification === 'removed') {
    return [
      head,
      '',
      'The pack is no longer published; clients keep the version they approved.',
      '',
    ];
  }
  const rows = change.changes
    .slice(0, MAX_FIELDS)
    .map((c) => `| \`${c.path}\` | ${cell(c.from)} | ${cell(c.to)} | ${c.class ?? 'new'} |`);
  const more = change.changes.length - MAX_FIELDS;
  return [
    head,
    '',
    '| Field | From | To | Class |',
    '|---|---|---|---|',
    ...rows,
    ...(more > 0 ? [`| … and ${more} more | | | |`] : []),
    '',
  ];
}

/** The report. */
export function summaryOf(check: RegistryCheck, base: string | null): string {
  const packs = check.collected.index.packs;
  const versions = packs.reduce((n, p) => n + p.versions.length, 0);
  const roots = check.roots.placeholder
    ? 'placeholders (the key ceremony has not run)'
    : check.roots.keys.map((k) => `\`${k.key_id}\``).join(', ');
  const keys =
    check.keys === null
      ? 'none yet'
      : `version ${check.keys.version}, expires ${check.keys.expires}, online keys ${check.keys.online.map((k) => `\`${k.key_id}\` (until ${k.not_after})`).join(', ')}`;
  const lines = [
    '### Site-pack registry',
    '',
    `${packs.length} packs, ${versions} listed versions. Root keys: ${roots}. keys.json: ${keys}.`,
    '',
  ];
  if (check.changes !== null) {
    lines.push(`Changes against \`${(base ?? '').slice(0, 12)}\`:`, '');
    if (check.changes.length === 0) lines.push('No pack changed.', '');
    for (const change of check.changes) lines.push(...changeRows(change));
    if (check.changes.length > 0) {
      lines.push(
        '_Classified as BrowserHive will (spec 13 §9.7), without the templates that use each pack: the `stealth-profile` rule that depends on them is not evaluated here. Loosening and restrictive changes, and new or removed domains, always wait for each operator._',
        '',
      );
    }
  }
  for (const note of check.notes) lines.push(`- ${note}`);
  if (check.notes.length > 0) lines.push('');
  if (check.errors.length > 0) {
    lines.push('**Problems:**', '', ...check.errors.map((e) => `- ${e}`), '');
  } else {
    lines.push('No problems found.', '');
  }
  return lines.join('\n');
}

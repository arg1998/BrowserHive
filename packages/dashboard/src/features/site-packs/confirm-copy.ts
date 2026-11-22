/** @module features/site-packs/confirm-copy — confirmation copy of the pack actions (spec 13 §11.4 Confirmations, spec 04 §11): applying a version, approving a local file (naming its SHA-256) and reverting, each following the change's classification (review #84 L1, L4); turning a pack off (review S-M2), adding a pack to an existing site. Pack strings are bidi-isolated (`iso`) */
import type {
  SitePackChange,
  SitePackClassification,
  SitePackView,
} from '@browserhive/contracts/http';
import type { ConfirmOptions } from '@/components/shared/ConfirmDialog.tsx';
import { bySeverity, CLASSIFICATION_INFO, needsCare } from './classification.ts';
import { iso } from './model.ts';

/** The templates line of a confirmation. */
function usedByText(pack: SitePackView): string {
  const n = pack.used_by.length;
  if (n === 0) return 'No template uses it yet.';
  return `${n} ${n === 1 ? 'template uses' : 'templates use'} it and ${n === 1 ? 'follows' : 'follow'} the change at once.`;
}

/** What applying a version of each classification means, in one sentence (spec 13 §9.7). */
const APPLY_CLASS_TEXT: { readonly [K in SitePackClassification]: string } = {
  loosening:
    'This version relaxes rules: check every highlighted field, it removes or weakens protections.',
  restrictive:
    'This version can stop agents from using the site: check every highlighted field before applying it.',
  tightening: 'This version only tightens rules.',
  neutral: 'This version changes no rule.',
  new_pack: 'Every rule of this pack is new.',
  local_override: 'This content replaces the published version.',
  revoked:
    'The publisher revoked the version in force; this earlier version relaxes rules or can stop the site.',
  unclassified: 'Review the changes first: they are not classified.',
};

/** Apply a pending version; a version that relaxes rules or can stop the site asks with care. */
export function applyConfirm(
  pack: SitePackView,
  version: number,
  classification: SitePackClassification = 'unclassified',
): ConfirmOptions {
  const from = pack.approved?.version;
  return {
    title: `Apply ${iso(pack.title)} v${version}?`,
    description:
      `${APPLY_CLASS_TEXT[classification]} ${usedByText(pack)}` +
      (from === undefined ? '' : ` v${from} is kept, so Revert restores it in one step.`),
    confirmLabel: `Apply v${version}`,
    danger: needsCare(classification),
  };
}

/** Approve a local file's content, named by its SHA-256; one that relaxes rules or can stop the site asks with care (review #84 L1). */
export function approveLocalConfirm(
  pack: SitePackView,
  path: string,
  sha256: string,
  classification: SitePackClassification = 'unclassified',
): ConfirmOptions {
  return {
    title: `Approve the local ${iso(pack.title)} file?`,
    description:
      `${LOCAL_CLASS_TEXT[classification]} ` +
      `BrowserHive keeps a copy of exactly this content and applies it in place of any other version. ` +
      `${usedByText(pack)} Later edits to the file change nothing until you approve them again.`,
    confirmLabel: 'Approve this content',
    items: [`SHA-256 ${sha256}`, iso(path)],
    itemsLabel: 'The content you reviewed',
    danger: needsCare(classification),
  };
}

/** What approving a local file of each classification means (the Apply sentences, for a file). */
const LOCAL_CLASS_TEXT: { readonly [K in SitePackClassification]: string } = {
  ...APPLY_CLASS_TEXT,
  loosening:
    'This file relaxes rules: check every highlighted field, it removes or weakens protections.',
  restrictive:
    'This file can stop agents from using the site: check every highlighted field before approving it.',
  tightening: 'This file only tightens rules.',
  neutral: 'This file changes no rule.',
  new_pack: 'Nothing was approved for this site before: every rule of this file is new.',
};

/** At most this many fields are named in the Revert confirmation; the rest are counted. */
const REVERT_FIELDS = 6;

/** What reverting to a version of each classification means. */
function revertClassText(version: string, classification: SitePackClassification): string {
  switch (classification) {
    case 'loosening':
      return `${version} relaxes rules compared with the version in force: it removes or weakens protections.`;
    case 'restrictive':
      return `${version} can stop agents from using the site.`;
    case 'tightening':
      return `${version} only tightens rules.`;
    case 'neutral':
      return `${version} changes no rule.`;
    default:
      return `What ${version} changes could not be classified.`;
  }
}

/**
 * Revert to the previous approved version, classified like Apply (review #84 L4): the class of
 * going back, the fields that relax rules or can stop the site, and care when it relaxes rules,
 * can stop the site or could not be classified.
 */
export function revertConfirm(
  pack: SitePackView,
  diff?: {
    readonly classification: SitePackClassification;
    readonly changes: readonly SitePackChange[];
  },
): ConfirmOptions {
  const previous = pack.previous;
  const classification = diff?.classification ?? 'unclassified';
  const careful = bySeverity(diff?.changes ?? []).filter((c) => needsCare(c.class));
  const items = careful
    .slice(0, REVERT_FIELDS)
    .map((c) => `${c.path} · ${c.class === null ? '' : CLASSIFICATION_INFO[c.class].label}`);
  if (careful.length > REVERT_FIELDS) items.push(`and ${careful.length - REVERT_FIELDS} more`);
  const version = previous === null ? 'The previous version' : `v${previous.version}`;
  return {
    title: `Revert ${iso(pack.title)}${previous === null ? '' : ` to v${previous.version}`}?`,
    description: `${revertClassText(version, classification)} ${usedByText(pack)} The current version stops applying to them.`,
    confirmLabel: 'Revert',
    danger: classification === 'unclassified' || needsCare(classification),
    ...(items.length > 0 && { items, itemsLabel: 'Fields to read first' }),
  };
}

/** Turn a pack off: every template using it loses its guards at once (review S-M2). */
export function disableConfirm(pack: SitePackView): ConfirmOptions {
  const n = pack.used_by.length;
  return {
    title: `Turn off ${iso(pack.title)}?`,
    description:
      (n === 0
        ? 'No template uses it now; templates that add its sites later get none of its rules. '
        : `${n} ${n === 1 ? 'template loses' : 'templates lose'} its sign-out, account and credential guards and its security checks at once. `) +
      'Its sites act as generic sites until you turn it on again.',
    confirmLabel: 'Turn off',
    danger: true,
  };
}

/** Attach a pack to a generic site of a template (spec 13 §9.6, D-67). */
export function attachPackConfirm(
  pack: SitePackView,
  choice: { readonly version: number; readonly sha256: string; readonly provenance: string },
  site: string,
): ConfirmOptions {
  return {
    title: `Use the ${iso(pack.title)} site pack for ${site}?`,
    description:
      'The site gets the pack’s sign-in check, guards and write policy. ' +
      'Adding it approves exactly the version below.',
    confirmLabel: 'Use the pack',
    items: [`SHA-256 ${choice.sha256}`, `v${choice.version} · ${iso(choice.provenance)}`],
    itemsLabel: 'The version you approve',
  };
}

/** One version of an Apply selected confirmation. */
export interface SelectedForApply {
  readonly title: string;
  readonly from: number | null;
  readonly version: number;
  readonly classification: SitePackClassification;
}

/**
 * Apply several downloaded versions at once (spec 13 §10.6 "take updates for some sites only"):
 * every version listed with its class, those that relax rules or can stop a site first, and care
 * when any does.
 */
export function applySelectedConfirm(items: readonly SelectedForApply[]): ConfirmOptions {
  const careful = items.filter((i) => needsCare(i.classification));
  const ordered = [...careful, ...items.filter((i) => !needsCare(i.classification))];
  const n = items.length;
  return {
    title: `Apply ${n} ${n === 1 ? 'version' : 'versions'}?`,
    description:
      (careful.length === 0
        ? `${n === 1 ? 'It only tightens' : 'Each only tightens'} rules or changes none. `
        : `${careful.length === n ? (n === 1 ? 'It relaxes' : 'Each relaxes') : `${careful.length} of them relax`} rules or can stop a site: read their highlighted fields first. `) +
      'They apply one after the other; templates using each pack follow at once, and each previous version is kept for Revert.',
    confirmLabel: `Apply ${n} ${n === 1 ? 'version' : 'versions'}`,
    items: ordered.map(
      (i) =>
        `${iso(i.title)} ${i.from === null ? '' : `v${i.from} → `}v${i.version} · ${CLASSIFICATION_INFO[i.classification].label}`,
    ),
    itemsLabel: 'Versions to apply',
    danger: careful.length > 0,
  };
}

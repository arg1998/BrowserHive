/** @module features/site-packs/confirm-copy — confirmation copy of the pack actions (spec 13 §11.4 Confirmations, spec 04 §11): applying a version, approving a local file (naming its SHA-256), reverting, turning a pack off (review S-M2), adding a pack to an existing site. Pack strings are bidi-isolated (`iso`) */
import type { SitePackClassification, SitePackView } from '@browserhive/contracts/http';
import type { ConfirmOptions } from '@/components/shared/ConfirmDialog.tsx';
import { needsCare } from './classification.ts';
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

/** Approve a local file's content, named by its SHA-256. */
export function approveLocalConfirm(
  pack: SitePackView,
  path: string,
  sha256: string,
): ConfirmOptions {
  return {
    title: `Approve the local ${iso(pack.title)} file?`,
    description:
      `BrowserHive keeps a copy of exactly this content and applies it in place of any other version. ` +
      `${usedByText(pack)} Later edits to the file change nothing until you approve them again.`,
    confirmLabel: 'Approve this content',
    items: [`SHA-256 ${sha256}`, iso(path)],
    itemsLabel: 'The content you reviewed',
  };
}

/** Revert to the previous approved version. */
export function revertConfirm(pack: SitePackView): ConfirmOptions {
  const previous = pack.previous;
  return {
    title: `Revert ${iso(pack.title)}${previous === null ? '' : ` to v${previous.version}`}?`,
    description: `${usedByText(pack)} The current version stops applying to them.`,
    confirmLabel: 'Revert',
    danger: true,
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

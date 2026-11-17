/** @module features/site-packs/confirm-copy — confirmation copy of the pack actions (spec 13 §11.4 Confirmations, spec 04 §11): applying a version, approving a local file (naming its SHA-256), reverting, adding a pack to an existing site */
import type { SitePackView } from '@browserhive/contracts/http';
import type { ConfirmOptions } from '@/components/shared/ConfirmDialog.tsx';

/** The templates line of a confirmation. */
function usedByText(pack: SitePackView): string {
  const n = pack.used_by.length;
  if (n === 0) return 'No template uses it yet.';
  return `${n} ${n === 1 ? 'template uses' : 'templates use'} it and ${n === 1 ? 'follows' : 'follow'} the change at once.`;
}

/** Apply a pending version. */
export function applyConfirm(pack: SitePackView, version: number): ConfirmOptions {
  const from = pack.approved?.version;
  return {
    title: `Apply ${pack.title} v${version}?`,
    description:
      `${usedByText(pack)} ` +
      (from === undefined
        ? 'Review the changes first: they are not classified yet.'
        : `v${from} is kept, so Revert restores it in one step. Review the changes first: they are not classified yet.`),
    confirmLabel: `Apply v${version}`,
  };
}

/** Approve a local file's content, named by its SHA-256. */
export function approveLocalConfirm(
  pack: SitePackView,
  path: string,
  sha256: string,
): ConfirmOptions {
  return {
    title: `Approve the local ${pack.title} file?`,
    description:
      `BrowserHive keeps a copy of exactly this content and applies it in place of any other version. ` +
      `${usedByText(pack)} Later edits to the file change nothing until you approve them again.`,
    confirmLabel: 'Approve this content',
    items: [path, `SHA-256 ${sha256}`],
    itemsLabel: 'The content you reviewed',
  };
}

/** Revert to the previous approved version. */
export function revertConfirm(pack: SitePackView): ConfirmOptions {
  const previous = pack.previous;
  return {
    title: `Revert ${pack.title}${previous === null ? '' : ` to v${previous.version}`}?`,
    description: `${usedByText(pack)} The current version stops applying to them.`,
    confirmLabel: 'Revert',
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
    title: `Use the ${pack.title} site pack for ${site}?`,
    description:
      'The site gets the pack’s sign-in check, guards and write policy. ' +
      'Adding it approves exactly the version below.',
    confirmLabel: 'Use the pack',
    items: [`v${choice.version} · ${choice.provenance}`, `SHA-256 ${choice.sha256}`],
    itemsLabel: 'The version you approve',
  };
}

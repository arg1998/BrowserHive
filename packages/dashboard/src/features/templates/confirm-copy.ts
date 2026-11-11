/** @module features/templates/confirm-copy — confirmation copy of the template actions (spec 13 §11.4 Confirmations, spec 04 §11): delete (typed name), disable and access changes that close sessions (listing them), restore, seeding over a ready template, removing a site, unseal flags, identity changes */
import type { ConfirmOptions } from '@/components/shared/ConfirmDialog.tsx';

/** Delete: typed name; says that deleting does not sign out at the sites. */
export function deleteTemplateConfirm(
  template: { readonly name: string; readonly display_name: string },
  liveSessions: readonly string[],
): ConfirmOptions {
  return {
    title: `Delete ${template.display_name}?`,
    description:
      'Its browser stops and its profile, sign-ins and versions are erased from this machine. ' +
      'Deleting does not sign you out at the sites: sign out there if the accounts should end too. ' +
      (liveSessions.length > 0
        ? 'The live sessions below are closed first; their agents lose their pages. '
        : '') +
      'Agents that use this name get "template not found". Type the name to confirm.',
    confirmLabel: 'Delete template',
    danger: true,
    requireText: template.name,
    ...(liveSessions.length > 0 && { items: liveSessions, itemsLabel: 'Sessions that close' }),
  };
}

/** Disable: lists the sessions that close now. */
export function disableTemplateConfirm(
  displayName: string,
  liveSessions: readonly string[],
): ConfirmOptions {
  return {
    title: `Disable ${displayName}?`,
    description:
      liveSessions.length > 0
        ? 'Agents can no longer launch it, and its live sessions close now. Sign-ins are kept; enable it again at any time.'
        : 'Agents can no longer launch it. Sign-ins are kept; enable it again at any time.',
    confirmLabel: 'Disable',
    danger: liveSessions.length > 0,
    ...(liveSessions.length > 0 && { items: liveSessions, itemsLabel: 'Sessions that close' }),
  };
}

/** An access change that closes sessions which lose access (spec 13 §3.2). */
export function accessChangeConfirm(liveSessions: readonly string[]): ConfirmOptions {
  return {
    title: 'Save the new access rule?',
    description:
      'Sessions whose agent is no longer allowed close now. Agents that are still allowed keep working.',
    confirmLabel: 'Save and close them',
    danger: true,
    items: liveSessions,
    itemsLabel: 'Sessions that may close',
  };
}

/** Restore: lists the sessions that close. */
export function restoreConfirm(label: string, liveSessions: readonly string[]): ConfirmOptions {
  return {
    title: `Restore ${label}?`,
    description:
      'The browser restarts with the sign-ins of that version, then every site is checked. Agents wait while it restarts. Sites you signed in to after it may be signed out; a new version is written either way, so you can go back.',
    confirmLabel: 'Restore',
    ...(liveSessions.length > 0 && { items: liveSessions, itemsLabel: 'Sessions that close' }),
  };
}

/** Seeding over a ready template. */
export function seedOverReadyConfirm(
  displayName: string,
  liveSessions: readonly string[] = [],
): ConfirmOptions {
  return {
    title: `Replace the sign-ins of ${displayName}?`,
    description:
      'The file’s cookies and storage are applied to the template’s browser, which restarts, so its live sessions close. The current state is kept as a version you can restore.',
    confirmLabel: 'Seed from file',
    danger: true,
    ...(liveSessions.length > 0 && { items: liveSessions, itemsLabel: 'Sessions that close' }),
  };
}

/** Removing a site. */
export function removeSiteConfirm(site: string): ConfirmOptions {
  return {
    title: `Remove ${site}?`,
    description:
      'Agents stop being offered this site and it is no longer checked. The browser keeps its cookies for the site; remove the sign-in separately if agents must not use it.',
    confirmLabel: 'Remove site',
    danger: true,
  };
}

/** Each unseal flag (spec 13 §5.4). */
export function unsealConfirm(flag: string, consequence: string): ConfirmOptions {
  return {
    title: `Allow ${flag}?`,
    description: `${consequence} Agents can then take the account's session material out of BrowserHive.`,
    confirmLabel: `Allow ${flag}`,
    danger: true,
  };
}

/** A proxy or channel change restarts the browser and may sign the accounts out (spec 13 §2.2). */
export function identityChangeConfirm(what: 'proxy' | 'channel'): ConfirmOptions {
  return {
    title: what === 'proxy' ? 'Change the proxy?' : 'Change the browser channel?',
    description:
      'The browser restarts. Sites see a new network or browser for the same account and may sign you out or ask you to confirm it is you.',
    confirmLabel: 'Change and restart',
    danger: true,
  };
}

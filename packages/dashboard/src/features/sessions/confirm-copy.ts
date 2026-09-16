/** @module features/sessions/confirm-copy — confirmation dialog copy shared by row actions, bulk actions and the detail header (spec 04 §11) */
import type { ConfirmOptions } from '@/components/shared/ConfirmDialog.tsx';

/** Delete confirmation: names exactly what is erased; bulk deletes require typing the count. */
export function deleteConfirm(count: number, slug?: string): ConfirmOptions {
  const many = count !== 1;
  const target = many ? 'these sessions' : (slug ?? 'this session');
  return {
    title: many ? `Delete ${count} sessions?` : `Delete ${slug ?? 'this session'}?`,
    description:
      `This permanently erases every trace of ${target} — all event-store rows (tool calls, pages, attention, vault audit) and every on-disk artifact (trace.zip, screenshots, the Chromium profile, downloads). A live session is terminated first. This cannot be undone — use Archive instead if you only want to hide ${many ? 'them' : 'it'}.` +
      (slug !== undefined && !many
        ? ` Type the slug to confirm.`
        : many
          ? ` Type ${count} to confirm.`
          : ''),
    confirmLabel: many ? `Delete ${count}` : 'Delete',
    danger: true,
    requireText: many ? String(count) : (slug ?? String(count)),
  };
}

/** Terminate confirmation. */
export function terminateConfirm(count: number, slug?: string): ConfirmOptions {
  const many = count !== 1;
  return {
    title: many ? `Terminate ${count} sessions?` : `Terminate ${slug ?? 'this session'}?`,
    description: many
      ? 'The browsers are closed now; the agents lose their pages. Records and artifacts stay.'
      : 'The browser is closed now; the agent loses its pages. Records and artifacts stay.',
    confirmLabel: 'Terminate',
    danger: true,
  };
}

/** Bulk archive / unarchive confirmation (single-row archive needs no confirm). */
export function archiveConfirm(action: 'archive' | 'unarchive', count: number): ConfirmOptions {
  return {
    title: `${action === 'archive' ? 'Archive' : 'Unarchive'} ${count} session${count === 1 ? '' : 's'}?`,
    description:
      action === 'archive'
        ? 'Archived sessions leave the main list and land under the Archived view. Nothing is deleted.'
        : 'The sessions return to the main list.',
    confirmLabel: action === 'archive' ? 'Archive' : 'Unarchive',
  };
}

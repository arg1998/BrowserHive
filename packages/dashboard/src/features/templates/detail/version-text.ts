/** @module features/templates/detail/version-text — how the Versions tab names a version's reason and summarises its per-domain cookies (names and counts only, D-20) */
import type { TemplateVersionReason, TemplateVersionRow } from '../pending/contracts.ts';

/** Why a version was written, in words. */
export const VERSION_REASON: { readonly [K in TemplateVersionReason]: string } = {
  recording: 'Sign-in finished',
  relogin: 'Signed in again',
  restore: 'Restored',
  manual: 'Saved by hand',
  import: 'Seeded from a file',
  signin_change: 'Sign-in cookies changed',
  daily: 'Daily snapshot',
};

/** The reason, with what a restore came from. */
export function reasonText(row: Pick<TemplateVersionRow, 'reason' | 'restored_from'>): string {
  if (row.reason === 'restore' && row.restored_from !== null) {
    return row.restored_from === 0
      ? 'Restored from the checkpoint'
      : `Restored from version ${row.restored_from}`;
  }
  return VERSION_REASON[row.reason];
}

/** One line per domain: `linkedin.com · 14 cookies · signed in by li_at`. */
export function summaryLines(summary: TemplateVersionRow['summary']): string[] {
  return Object.entries(summary)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([domain, s]) => {
      const parts = [domain];
      if (s.cookies !== undefined)
        parts.push(`${s.cookies} ${s.cookies === 1 ? 'cookie' : 'cookies'}`);
      if (s.signin_cookies !== undefined && s.signin_cookies.length > 0)
        parts.push(`sign-in: ${s.signin_cookies.join(', ')}`);
      return parts.join(' · ');
    });
}

/** Largest seed file accepted (spec 13 §7.4). */
export const SEED_MAX_BYTES = 16 * 1024 * 1024;

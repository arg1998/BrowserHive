/** @module features/templates/detail/version-text — how the Versions tab names a version's reason, summarises its per-domain cookies (names and counts only, D-20) and explains the refusals of restore and seed */
import {
  TEMPLATE_SEED_MAX_BYTES,
  type TemplateVersionReason,
  type TemplateVersionRow,
} from '@browserhive/contracts/http';
import type { AppError } from '@/lib/api/errors.ts';

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

/** One line per domain: `linkedin.com · 14 cookies · sign-in: li_at`. */
export function summaryLines(summary: TemplateVersionRow['summary']): string[] {
  return [...summary.domains]
    .sort((a, b) => a.domain.localeCompare(b.domain))
    .map((d) => {
      const parts = [d.domain, `${d.cookies} ${d.cookies === 1 ? 'cookie' : 'cookies'}`];
      if (d.sign_in_cookies.length > 0) parts.push(`sign-in: ${d.sign_in_cookies.join(', ')}`);
      return parts.join(' · ');
    });
}

/** Largest seed file accepted (spec 13 §7.4). */
export const SEED_MAX_BYTES = TEMPLATE_SEED_MAX_BYTES;

/** Why a restore or seed was refused, in words (spec 13 §11.1 errors). */
export function operationRefusal(error: AppError, what: 'restore' | 'seed'): string {
  switch (error.code) {
    case 'CONFLICT':
      return what === 'seed' && error.message.toLowerCase().includes('confirm')
        ? 'The template is ready; seeding over it needs your confirmation.'
        : 'Another restore, seed or clean-up is running for this template. Try again when it finishes.';
    case 'TEMPLATE_VERSION_UNREADABLE':
      return 'This server does not hold the key these sign-ins were saved with. Set templateKeyPrevious, or restore another version.';
    case 'TEMPLATE_DISABLED':
      return 'The template is disabled. Enable it first.';
    case 'TEMPLATE_VERSION_NOT_FOUND':
      return 'That version no longer exists.';
    case 'PAYLOAD_TOO_LARGE':
      return 'The file is larger than 16 MiB.';
    case 'VALIDATION_FAILED':
      return 'That file is not a Playwright storage state.';
    default:
      return error.message;
  }
}

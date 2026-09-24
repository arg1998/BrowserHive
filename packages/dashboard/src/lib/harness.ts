/** @module lib/harness — dashboard copy for self-reported client identity (D-30): labels, how a harness was recognised, and the one plain note that none of it can be verified */
import { harnessLabel, UNKNOWN_HARNESS } from '@browserhive/contracts/harness';

export { harnessLabel, UNKNOWN_HARNESS };

/** The one sentence every identity surface carries, once, in its info popover. */
export const SELF_REPORTED_NOTE =
  "Reported by the client or by your configuration. BrowserHive can't verify it.";

/** How a harness was recognised, as a short phrase (open vocabulary: unknown sources read as themselves). */
export function harnessSourcePhrase(source: string | null | undefined): string {
  switch (source) {
    case 'env':
      return 'declared in BROWSERHIVE_HARNESS';
    case 'header':
      return 'declared by header';
    case 'injected_env':
      return 'set by the harness';
    case 'url':
      return 'declared in the URL';
    case 'meta':
      return 'declared in _meta';
    case 'client_info':
      return 'from clientInfo';
    case 'user_agent':
      return 'from the User-Agent';
    case 'none':
    case null:
    case undefined:
      return 'not identified';
    default:
      return source;
  }
}

/** Where a declared model came from, as a short phrase. */
export function declaredSourcePhrase(source: string | null | undefined): string | null {
  switch (source) {
    case 'header':
      return 'by header';
    case 'env':
      return 'by BROWSERHIVE_MODEL';
    case 'meta':
      return 'in _meta';
    case null:
    case undefined:
      return null;
    default:
      return source;
  }
}

/** Whether a slug means "nothing identified the client". */
export function isUnknownHarness(slug: string | null | undefined): boolean {
  return slug === null || slug === undefined || slug === '' || slug === UNKNOWN_HARNESS;
}

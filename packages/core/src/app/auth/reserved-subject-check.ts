/** @module app/auth/reserved-subject-check — finds agent tokens that already act as a reserved subject (spec 13 T0f), for `browserhive doctor` and the boot warning; never revokes anything. */

import { isReservedSubject } from '../../domain/auth/reserved-subjects.ts';
import { parseConfigTokens } from './providers/bearer-token.ts';

/** The slice of a token listing the check reads (`ApiTokenView` and the CLI's `TokenRow` fit). */
export interface TokenListingRow {
  readonly credentialId: string;
  readonly publicPrefix: string;
  readonly ownerKind: 'agent' | 'operator';
  readonly subject: string;
}

/** An active stored token whose principal has a reserved subject. */
export interface ReservedSubjectToken {
  readonly subject: string;
  readonly credentialId: string;
  readonly publicPrefix: string;
}

/** What {@link findReservedSubjects} found; both lists empty means nothing to do. */
export interface ReservedSubjectFindings {
  /** Stored agent tokens (`credentials` rows) to revoke. */
  readonly tokens: readonly ReservedSubjectToken[];
  /** `authTokens` config items whose name is reserved (names only, never the token). */
  readonly configNames: readonly string[];
}

/**
 * Agent tokens created before token creation refused reserved subjects, and `authTokens` items
 * named after one. Such a token acts as `local` (or `browserhive`, `system`, `template:…`), so
 * its agent owns what that subject owns. The operator decides; this only reports.
 */
export function findReservedSubjects(
  tokens: readonly TokenListingRow[],
  authTokens: readonly string[],
): ReservedSubjectFindings {
  return {
    tokens: tokens
      .filter((t) => t.ownerKind === 'agent' && isReservedSubject(t.subject))
      .map((t) => ({
        subject: t.subject,
        credentialId: t.credentialId,
        publicPrefix: t.publicPrefix,
      })),
    configNames: [
      ...new Set(
        parseConfigTokens(authTokens)
          .map((t) => t.principalId)
          .filter((name) => isReservedSubject(name)),
      ),
    ],
  };
}

/** True when there is something to report. */
export function hasReservedSubjects(findings: ReservedSubjectFindings): boolean {
  return findings.tokens.length > 0 || findings.configNames.length > 0;
}

/**
 * One operator-facing sentence naming every finding and what to do about it, shared by the doctor
 * row and the boot warning.
 */
export function describeReservedSubjects(findings: ReservedSubjectFindings): string {
  const parts: string[] = [];
  if (findings.tokens.length > 0) {
    const list = findings.tokens
      .map((t) => `${t.subject} (credential ${t.credentialId}, prefix ${t.publicPrefix})`)
      .join(', ');
    parts.push(
      `agent tokens with a reserved subject: ${list}; revoke each with 'browserhive admin tokens revoke <credential>' or on the dashboard (System, Agent tokens) and issue a new token under another name`,
    );
  }
  if (findings.configNames.length > 0) {
    parts.push(
      `authTokens items with a reserved name: ${findings.configNames.join(', ')}; rename them in the config`,
    );
  }
  return parts.join('; ');
}

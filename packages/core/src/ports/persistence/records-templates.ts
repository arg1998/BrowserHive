/** @module ports/persistence/records-templates — rows of `templates` and `template_sites` (spec 13 §2.1–§2.3, §2.5). */

import type {
  AgentWindowState,
  SessionChannel,
  SiteWritePolicy,
  TemplateHealthState,
  TemplateStatus,
  TemplateStealthLevel,
} from './enums.ts';

/** Operator-given coordinates (never invented, spec 11 §2.5). */
export interface TemplateGeolocationRecord {
  readonly latitude: number;
  readonly longitude: number;
  readonly accuracy?: number;
}

/** The identity fixed at creation (spec 13 §2.2); `identity_json`. No secret. */
export interface PinnedIdentityRecord {
  /** 21 random characters; feeds the fingerprint derivation for the template's life. */
  readonly seed: string;
  readonly locale: string;
  readonly languages: readonly string[];
  readonly timezoneId: string;
  readonly countryCode: string | null;
  readonly geolocation?: TemplateGeolocationRecord;
}

/** A UA-CH brand entry. */
export interface BrandRecord {
  readonly brand: string;
  readonly version: string;
}

/** What the first host start read from the running browser (spec 13 §2.2); `identity_observed_json`. */
export interface ObservedIdentityRecord {
  readonly chromeMajor: string;
  readonly userAgent: string;
  readonly uaCh: {
    readonly brands: readonly BrandRecord[];
    readonly fullVersionList: readonly BrandRecord[];
    readonly platform: string;
    readonly platformVersion: string;
    readonly architecture: string;
    readonly bitness: string;
  };
  readonly screen: {
    readonly width: number;
    readonly height: number;
    readonly deviceScaleFactor: number;
  };
  readonly window: { readonly width: number; readonly height: number };
  readonly observedAt: number;
}

/** A template's pinned proxy; `password_env` is a variable NAME (D-33). `proxy_json`. */
export interface TemplateProxyRecord {
  readonly server: string;
  readonly bypass: string | null;
  readonly username: string | null;
  readonly passwordEnv: string | null;
  readonly label: string;
}

/**
 * Unseal flags (spec 13 §5.4, D-51); `unseal_json`. Every flag `false` = sealed. `principals`
 * `null` = the flags apply to every principal the template allows.
 */
export interface TemplateUnsealRecord {
  readonly cookieValues: boolean;
  readonly evaluate: boolean;
  readonly cookieWrites: boolean;
  readonly stateExport: boolean;
  readonly principals: readonly string[] | null;
}

/** One `templates` row. */
export interface TemplateRecord {
  readonly templateId: string;
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly status: TemplateStatus;
  /** The operator principal that created it. */
  readonly owner: string;
  readonly tenantId: string | null;
  readonly channel: SessionChannel;
  readonly headless: boolean;
  readonly stealth: TemplateStealthLevel;
  readonly fingerprint: boolean;
  readonly humanize: boolean;
  readonly identity: PinnedIdentityRecord;
  readonly identityObserved: ObservedIdentityRecord | null;
  readonly proxy: TemplateProxyRecord | null;
  readonly agentWindows: AgentWindowState;
  /** Empty = any principal (spec 13 §6.1). */
  readonly authorizedPrincipals: readonly string[];
  /** D-48: `null` = every harness, `[]` = none. */
  readonly harnesses: readonly string[] | null;
  readonly maxConcurrent: number;
  readonly unseal: TemplateUnsealRecord;
  readonly healthIntervalMs: number;
  readonly prelaunchCheck: boolean;
  readonly currentVersion: number | null;
  readonly checkpointAt: number | null;
  readonly checkpointSizeBytes: number | null;
  /** Optimistic-concurrency row version (D-14). */
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastUsedAt: number | null;
  readonly disabledAt: number | null;
}

/** Fields `TemplateRepository.update` may change (identity seed and creation facts never change). */
export type TemplatePatch = Partial<
  Omit<TemplateRecord, 'templateId' | 'owner' | 'tenantId' | 'createdAt' | 'version'>
>;

/** A site's sign-in state (spec 13 §2.3, §8). */
export interface TemplateSiteHealthRecord {
  readonly state: TemplateHealthState;
  readonly reason: string | null;
  readonly checkedAt: number | null;
  readonly changedAt: number | null;
  readonly consecutiveInconclusive: number;
}

/** Selectors auto-relogin fills (spec 13 §8.4); `form_json`. */
export interface TemplateSiteFormRecord {
  readonly username: string;
  readonly password: string;
  readonly submit?: string;
  readonly next?: string;
}

/** One `template_sites` row. */
export interface TemplateSiteRecord {
  readonly templateId: string;
  /** The registrable domain. */
  readonly siteId: string;
  readonly packId: string | null;
  readonly packVersion: number | null;
  readonly enabled: boolean;
  /** `null` = the pack's default. */
  readonly writePolicy: SiteWritePolicy | null;
  readonly vaultHandle: string | null;
  readonly autoRelogin: boolean;
  readonly form: TemplateSiteFormRecord | null;
  /** Generic sites only (spec 13 §8.1); names, never values. */
  readonly learnedCookieNames: readonly string[];
  readonly health: TemplateSiteHealthRecord;
  readonly stoppedAt: number | null;
  readonly deviceBound: boolean;
  readonly addedAt: number;
}

/** The health of a site that was never probed. */
export const UNKNOWN_SITE_HEALTH: TemplateSiteHealthRecord = {
  state: 'unknown',
  reason: null,
  checkedAt: null,
  changedAt: null,
  consecutiveInconclusive: 0,
};

/** The template a session was launched from (`sessions.template_*`, written once at launch). */
export interface SessionTemplateRecord {
  /** `null` once the template was deleted (`ON DELETE SET NULL`); the name survives. */
  readonly templateId: string | null;
  /** The name at launch. */
  readonly name: string;
  /** `current_version` at launch. */
  readonly version: number | null;
  /** `live` (an agent's virtual session) or `maintenance` (BrowserHive's own). */
  readonly mode: 'live' | 'maintenance';
}

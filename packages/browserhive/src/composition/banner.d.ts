/** @module composition/banner — the startup banner (spec 08 §8): pure rendering from boot facts; printed once through `output` in the `ready` phase, never logged. */
/** Everything the banner shows. */
export interface BannerFacts {
  readonly version: string;
  readonly bunVersion: string;
  /** Resolved driver and its package version. */
  readonly driver: {
    readonly name: 'patchright' | 'playwright';
    readonly version: string | null;
  };
  readonly transport: 'http' | 'stdio';
  /** `http://host:port` (http only). */
  readonly url: string | null;
  readonly auth: 'off' | 'token';
  readonly admin: boolean;
  readonly dataDir: string;
  readonly db: {
    readonly schemaVersion: number;
    readonly sizeBytes: number;
    readonly backups: number;
  };
  /** `configSourceSummary` text. */
  readonly configSummary: string;
  readonly sessions: {
    readonly cap: number | 'unbounded';
    /** Host RAM in GiB when the cap was derived from it. */
    readonly derivedFromGib: number | null;
    /** Canonical lease rendering (`2h`). */
    readonly lease: string;
    readonly persistence: string;
  };
  readonly stealth: {
    readonly level: string;
    readonly humanize: boolean;
    readonly fingerprint: boolean;
  };
  readonly telemetry: {
    readonly endpoint: string;
    readonly protocol: string;
  } | null;
  readonly vault: {
    readonly backend: 'off' | 'bitwarden';
    readonly unlocked: boolean;
  };
  readonly shadowLines: readonly string[];
  /** Resolver warnings (insecure bind acknowledged…), rendered as a red block. */
  readonly warnings: readonly string[];
  readonly adminPassword: {
    readonly password: string;
    readonly path: string;
  } | null;
  readonly agentToken: {
    readonly principalId: string;
    readonly token: string;
  } | null;
  /** Browser binary missing (degraded, not fatal). */
  readonly browserMissing: boolean;
  /** Notification channels and where their links point (shown when either is configured). */
  readonly notifications?: {
    readonly channels: number;
    readonly startup: number;
    readonly publicUrl: string | null;
  };
}
/** `2.0 MiB`-style size without a dependency on core formatting. */
export declare function formatMib(bytes: number): string;
/** Renders the banner lines (no trailing newline per line). */
export declare function renderBanner(
  facts: BannerFacts,
  options: {
    readonly color: boolean;
  },
): string[];
//# sourceMappingURL=banner.d.ts.map

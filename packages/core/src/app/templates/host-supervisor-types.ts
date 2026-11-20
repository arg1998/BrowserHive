/** @module app/templates/host-supervisor-types — the settings and collaborators of the template host supervisor (spec 13 §3.2, §3.9). */

import type { SessionPrincipal } from '../../domain/session/principal.ts';
import type { Clock } from '../../ports/clock.ts';
import type { DegradationReporter } from '../../ports/degradation-reporter.ts';
import type { EventPublisher } from '../../ports/event-bus.ts';
import type { Logger } from '../../ports/logger.ts';
import type {
  TemplateHealthState,
  TemplateRecord,
  TemplateRepository,
  TemplateSiteRecord,
} from '../../ports/persistence/index.ts';
import type { SitePackLookup } from '../../ports/site-packs.ts';
import type { TemplateHost, TemplateHostLauncher } from '../../ports/template-host.ts';
import type { DomainEvents } from '../events/catalog.ts';
import type { SessionService } from '../sessions/session-service.ts';
import type { StrategyStateStore } from '../site-packs/strategy-state.ts';
import type { HostSpecDeps } from './host-spec.ts';

/** The slug of the per-host system maintenance session; it does not keep a host from idling. */
export const SYSTEM_MAINTENANCE_SLUG = 'maintenance';

/** Supervisor settings (08 §5.9; durations in ms, `0` = never). */
export interface HostSupervisorConfig {
  readonly idleTimeoutMs: number;
  readonly recycleAfterMs: number;
  readonly drainTimeoutMs: number;
  readonly maxPagesPerHost: number;
  readonly closeTimeoutMs: number;
  /** `templateRecycleRss` in bytes; `0` or absent = no memory limit. */
  readonly recycleRssBytes?: number;
}

/** The checkpoints the supervisor drives (spec 13 §3.9; `TemplateStateService`). */
export interface HostCheckpoints {
  /**
   * Rewrites the checkpoint now (clean stop, shutdown); `host` is the host being stopped (it is
   * `draining`, no longer the running one). Never throws.
   */
  checkpoint(templateId: string, host?: TemplateHost): Promise<unknown>;
  /** Rewrites it when `templateCheckpointInterval` has passed. Never throws. */
  checkpointIfDue(templateId: string, startedAt: number | null): Promise<unknown>;
}

/** Collaborators of {@link TemplateHostSupervisor}. */
export interface HostSupervisorDeps {
  readonly launcher: TemplateHostLauncher;
  readonly sessions: SessionService;
  readonly templates: Pick<TemplateRepository, 'update' | 'touchLastUsed'>;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly degradations: DegradationReporter;
  readonly spec: HostSpecDeps;
  readonly config: HostSupervisorConfig;
  /** Resident memory of a browser's process tree (spec 13 §3.2 memory); absent = not sampled. */
  readonly rssOf?: (pid: number) => Promise<number | null>;
  /** The `templates` topic (`template.host`). */
  readonly bus?: EventPublisher<DomainEvents>;
  /** The template's summary changed (identity drift): the service publishes `template.changed`. */
  readonly onTemplateChanged?: (templateId: string) => void;
  /** The approved site packs for the admission strategies; `null` under `sitePacks=false`. */
  readonly sitePacks?: () => SitePackLookup | null;
  /** In [0, 1): the `launch-spacing` jitter (tests inject it). */
  readonly random?: () => number;
  /** Persists the `launch-spacing` turns across a restart (D53). */
  readonly strategyState?: StrategyStateStore;
}

/** What a launch learned from the pre-launch check (spec 13 §8.2). */
export interface PrelaunchOutcome {
  /** Enabled sites with their state for this launch. */
  readonly sites: readonly { readonly site: string; readonly status: TemplateHealthState }[];
  /** Enabled sites signed out or challenged. */
  readonly out: readonly string[];
}

/** The health hooks of the supervisor (attached at composition, spec 13 §8.2, §8.3). */
export interface SupervisorHealth {
  /**
   * The pre-launch check, after the browser runs (spec 13 §8.2).
   *
   * @throws AppError `TEMPLATE_NEEDS_LOGIN` when every enabled site is out.
   */
  prelaunch?(template: TemplateRecord, signal: AbortSignal): Promise<PrelaunchOutcome>;
  /** A browser started: every site is probed (spec 13 §8.3). Never throws. */
  hostStarted?(templateId: string): void;
}

/** A maintenance session to open (`TemplateHostSupervisor.launchMaintenance`). */
export interface MaintenanceLaunch {
  readonly template: TemplateRecord;
  readonly sites: readonly TemplateSiteRecord[];
  readonly slug: string;
  readonly principal: SessionPrincipal;
  /** A recording or re-login window: agent windows are minimized while it is open (§3.3). */
  readonly recording?: boolean;
  /** A page BrowserHive works in by itself (a probe): minimized on a headed host (§8.1). */
  readonly background?: boolean;
  readonly signal?: AbortSignal;
  /** The token of the operation holding the template, if this launch is that operation's. */
  readonly holdToken?: symbol;
}

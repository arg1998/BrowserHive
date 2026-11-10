/** @module test/helpers/template-kit — a `TemplateService` over in-memory repositories, a fake runtime with scriptable host facts and launch, and fake template files. */

import {
  TemplateService,
  type TemplateServiceConfig,
} from '../../src/app/templates/template-service.ts';
import { UnavailableTemplateRuntime } from '../../src/app/templates/unavailable-runtime.ts';
import type { CreateSessionInput } from '../../src/domain/session/create-request.ts';
import type { Session } from '../../src/domain/session/session.ts';
import type { Clock } from '../../src/ports/clock.ts';
import type { Degradation, DegradationReporter } from '../../src/ports/degradation-reporter.ts';
import type { TemplateGeoResolver } from '../../src/ports/geo-seed-resolver.ts';
import type { IdGenerator } from '../../src/ports/id-generator.ts';
import type { Logger } from '../../src/ports/logger.ts';
import type { TemplateFiles } from '../../src/ports/template-files.ts';
import {
  STOPPED_HOST,
  type TemplateHostView,
  type TemplateLaunchRequest,
  type TemplateRuntime,
} from '../../src/ports/template-runtime.ts';
import { InMemoryRepositories, InMemoryUnitOfWork } from './in-memory-repos.ts';
import { InMemoryOperatorActionRepository } from './in-memory-vault-repos.ts';

/**
 * The exclusive-session input a fake runtime may build for a template launch: only from the
 * request's settings and identity, never from the agent's arguments (the request carries none).
 */
export function sessionInputFromRequest(request: TemplateLaunchRequest): CreateSessionInput {
  const s = request.settings;
  return {
    slug: request.slug,
    channel: s.channel,
    headless: s.headless,
    incognito: s.incognito,
    persistenceMode: s.persistenceMode,
    disableEvaluate: s.disableEvaluate,
    vaultEnabled: s.vaultEnabled,
    stealth: s.stealth,
    fingerprint: s.fingerprint,
    humanize: s.humanize,
    connectionId: request.connectionId,
    client: request.client,
  };
}

/**
 * A runtime whose host facts and launch tests script. Without `onLaunch` a launch behaves like the
 * production runtime before templates T1a-2 (`TEMPLATE_UNAVAILABLE`).
 */
export class FakeTemplateRuntime implements TemplateRuntime {
  readonly hosts = new Map<string, Partial<TemplateHostView>>();
  readonly sessions = new Map<string, string[]>();
  readonly launches: TemplateLaunchRequest[] = [];
  readonly shutdowns: string[] = [];
  onLaunch: ((request: TemplateLaunchRequest) => Promise<Session>) | null = null;

  host(templateId: string): TemplateHostView {
    const live = this.sessions.get(templateId) ?? [];
    return { ...STOPPED_HOST, liveAgentSessions: live.length, ...this.hosts.get(templateId) };
  }

  liveSessions(templateId: string): readonly string[] {
    return this.sessions.get(templateId) ?? [];
  }

  launch(request: TemplateLaunchRequest): Promise<Session> {
    this.launches.push(request);
    if (this.onLaunch !== null) return this.onLaunch(request);
    return new UnavailableTemplateRuntime().launch(request);
  }

  shutdown(templateId: string): Promise<readonly string[]> {
    this.shutdowns.push(templateId);
    const closed = this.sessions.get(templateId) ?? [];
    this.sessions.delete(templateId);
    return Promise.resolve(closed);
  }
}

/** Records degradation reports and recoveries. */
export class RecordingDegradations implements DegradationReporter {
  readonly reports: Degradation[] = [];
  readonly recoveries: string[] = [];

  report(degradation: Degradation): void {
    this.reports.push(degradation);
  }

  recovered(code: string): void {
    this.recoveries.push(code);
  }
}

/** Template directories in memory: `bytes` per template id, `removed` in order. */
export class FakeTemplateFiles implements TemplateFiles {
  readonly bytes = new Map<string, number>();
  readonly removed: string[] = [];

  dirOf(templateId: string): string {
    return `/data/templates/${templateId}`;
  }

  removeTemplateDir(templateId: string): Promise<number> {
    this.removed.push(templateId);
    const size = this.bytes.get(templateId) ?? 0;
    this.bytes.delete(templateId);
    return Promise.resolve(size);
  }
}

/** Explicit values win; the host seed is `en-US` / `UTC`. */
export const FAKE_TEMPLATE_GEO: TemplateGeoResolver = {
  resolve: (explicit) => {
    const locale = explicit.locale ?? 'en-US';
    const region = locale.split('-')[1];
    return Promise.resolve({
      locale,
      languages: locale.includes('-') ? [locale, locale.split('-')[0] ?? locale] : [locale],
      countryCode: region === undefined ? null : region.toUpperCase(),
      timezoneId: explicit.timezoneId ?? 'UTC',
    });
  },
};

/** Options of {@link createTemplateKit}. */
export interface TemplateKitOptions {
  readonly clock: Clock;
  readonly ids: Pick<IdGenerator, 'opaque' | 'eventId'>;
  readonly logger: Logger;
  readonly runtime?: TemplateRuntime;
  readonly config?: Partial<TemplateServiceConfig>;
}

/** The kit. */
export interface TemplateKit {
  readonly service: TemplateService;
  readonly repos: InMemoryRepositories;
  readonly actions: InMemoryOperatorActionRepository;
  readonly runtime: TemplateRuntime;
  readonly files: FakeTemplateFiles;
  readonly degradations: RecordingDegradations;
}

/** Builds a {@link TemplateKit}. */
export function createTemplateKit(options: TemplateKitOptions): TemplateKit {
  const repos = new InMemoryRepositories();
  const actions = new InMemoryOperatorActionRepository();
  const bundle = { ...repos, operatorActions: actions };
  const files = new FakeTemplateFiles();
  const runtime = options.runtime ?? new FakeTemplateRuntime();
  const degradations = new RecordingDegradations();
  const service = new TemplateService({
    repos: bundle,
    uow: new InMemoryUnitOfWork(bundle),
    runtime,
    geo: FAKE_TEMPLATE_GEO,
    files,
    degradations,
    ids: options.ids,
    clock: options.clock,
    logger: options.logger,
    config: {
      enabled: true,
      authMode: 'off',
      maxPagesPerHost: 40,
      defaults: { channel: 'chromium', stealth: 'standard', fingerprint: false, humanize: false },
      ...options.config,
    },
  });
  return { service, repos, actions, runtime, files, degradations };
}

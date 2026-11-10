/** @module composition/phases/domain-templates — the template service (spec 13 §2, §5, §6, §11.1): repositories, the pinned-identity geo, the template directories and the host runtime. Until the host supervisor lands (templates T1a-2) the runtime has no hosts and every template launch answers `TEMPLATE_UNAVAILABLE`. */

import { join } from 'node:path';
import type { ServerConfig } from '@browserhive/contracts/config';
import type { SqliteUnitOfWork } from '@browserhive/core/persistence';
import type { Clock, IdGenerator, Logger } from '@browserhive/core/runtime';
import {
  createTemplateFiles,
  createTemplateGeoResolver,
  type HostFacts,
  HostGeoSeedResolver,
  TemplateService,
  UnavailableTemplateRuntime,
} from '@browserhive/core/server';

/** Inputs of {@link buildTemplates}. */
export interface TemplatesInput {
  readonly config: Readonly<ServerConfig>;
  readonly host: HostFacts;
  readonly uow: SqliteUnitOfWork;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
}

/** `<data-dir>/templates` (spec 13 §2.4). */
export function templatesDirOf(dataDir: string): string {
  return join(dataDir, 'templates');
}

/** Builds the template service. */
export function buildTemplates(input: TemplatesInput): TemplateService {
  const { config } = input;
  return new TemplateService({
    repos: input.uow.repos,
    uow: input.uow,
    runtime: new UnavailableTemplateRuntime(),
    geo: createTemplateGeoResolver(new HostGeoSeedResolver(input.host)),
    files: createTemplateFiles(templatesDirOf(config.dataDir)),
    ids: input.ids,
    clock: input.clock,
    logger: input.logger,
    config: {
      enabled: config.templates,
      authMode: config.auth,
      maxPagesPerHost: config.templateMaxPagesPerHost,
      defaults: {
        channel: config.defaultChannel,
        stealth: config.stealth,
        fingerprint: config.fingerprint,
        humanize: config.humanize,
      },
    },
  });
}

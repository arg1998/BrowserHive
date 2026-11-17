/** @module interface/http/services-templates — the slices of the template and site-pack services the routes receive (spec 13 §11.1). */

import type { TemplateVersionsPage } from '@browserhive/contracts/http';
import type { SitePackRegistry } from '../../app/site-packs/registry.ts';
import type { TemplateHealthFacade } from '../../app/templates/health-facade.ts';
import type { TemplateActions } from '../../app/templates/template-actions.ts';
import type { TemplateEditService } from '../../app/templates/template-edit.ts';
import type { TemplateOperations } from '../../app/templates/template-operations.ts';
import type { TemplateRecordingService } from '../../app/templates/template-recording.ts';
import type { TemplateService } from '../../app/templates/template-service.ts';

/** The site-pack routes' service (a structural slice of `SitePackRegistry`). */
export type SitePacksPort = Pick<
  SitePackRegistry,
  | 'list'
  | 'detail'
  | 'diff'
  | 'apply'
  | 'reject'
  | 'revert'
  | 'pin'
  | 'setFollow'
  | 'approveLocal'
  | 'setEnabled'
  | 'reload'
  | 'importPack'
  | 'changes'
  | 'guardHits'
>;

/** The health and re-login routes' service. */
export type TemplateHealthPort = Pick<
  TemplateHealthFacade,
  | 'probe'
  | 'probes'
  | 'startRelogin'
  | 'confirmRelogin'
  | 'cancelRelogin'
  | 'show'
  | 'continueAgents'
  | 'putLink'
>;

/** The template edit routes' service. */
export type TemplateEditPort = Pick<
  TemplateEditService,
  'update' | 'setEnabled' | 'putSite' | 'removeSite' | 'resolveAccess'
>;

/** The template action routes' service. */
export type TemplateActionsPort = Pick<
  TemplateActions,
  'host' | 'closePage' | 'saveVersion' | 'pin' | 'dataDir'
>;

/** The versions list. */
export interface TemplateVersionsPort {
  list(
    templateId: string,
    query: { readonly cursor?: string | undefined; readonly limit: number },
  ): Promise<TemplateVersionsPage>;
}

/** Restore and seed. */
export type TemplateOperationsPort = Pick<TemplateOperations, 'get' | 'restore' | 'seed'>;

/** The recording routes' service (a structural slice of `TemplateRecordingService`). */
export type TemplateRecordingPort = Pick<
  TemplateRecordingService,
  'start' | 'confirm' | 'finish' | 'cancel' | 'removeSignIn' | 'clearProfileSecrets'
>;

/** The template routes' service (a structural slice of `TemplateService`). */
export type TemplatesPort = Pick<TemplateService, 'list' | 'get' | 'create' | 'remove'>;

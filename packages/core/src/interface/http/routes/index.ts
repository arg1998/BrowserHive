/** @module interface/http/routes — the complete `/api/v1` route table (one descriptor per `HTTP_ENDPOINTS` entry). */

import type { Logger } from '../../../ports/logger.ts';
import type { AnyRoute } from '../define-route.ts';
import { ATTENTION_ROUTES } from './attention.ts';
import { AUTH_ROUTES } from './auth.ts';
import { BLOCKLIST_ROUTES } from './blocklist.ts';
import { FLEET_ROUTES } from './fleet.ts';
import { LOG_ROUTES } from './logs.ts';
import { type MetaRouteDeps, metaRoutes } from './meta.ts';
import { NOTIFICATION_ROUTES } from './notifications.ts';
import { searchRoutes } from './search.ts';
import { SESSION_ARTIFACT_ROUTES } from './session-artifacts.ts';
import { SESSION_FACT_ROUTES } from './session-facts.ts';
import { SESSION_LIVE_ROUTES } from './session-live.ts';
import { SESSION_ROUTES } from './sessions.ts';
import { SYSTEM_ROUTES } from './system.ts';
import { VAULT_ROUTES } from './vault.ts';
import { VAULT_BINDING_ROUTES } from './vault-bindings.ts';

/** Builds the full route table. */
export function apiRoutes(deps: MetaRouteDeps & { readonly logger: Logger }): readonly AnyRoute[] {
  return [
    ...metaRoutes(deps),
    ...AUTH_ROUTES,
    ...SESSION_ROUTES,
    ...SESSION_FACT_ROUTES,
    ...SESSION_ARTIFACT_ROUTES,
    ...SESSION_LIVE_ROUTES,
    ...FLEET_ROUTES,
    ...ATTENTION_ROUTES,
    ...VAULT_ROUTES,
    ...VAULT_BINDING_ROUTES,
    ...BLOCKLIST_ROUTES,
    ...SYSTEM_ROUTES,
    ...LOG_ROUTES,
    ...NOTIFICATION_ROUTES,
    ...searchRoutes(deps.logger),
  ];
}

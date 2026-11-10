/** @module features/templates/pending/client — typed calls to the template routes T1b adds (spec 13 §11.1), over the dashboard's transport (cookies, timeouts, problem+json, the 401 interceptor) with the shapes of `./contracts.ts`. A server without them answers 404 `NOT_FOUND`, which the pages show as "not available on this server" (`isRouteMissing`). Replaced by `OPERATIONS` entries once the contracts export these routes. */
import type { z } from 'zod';
import { useApi } from '@/app/providers/AuthProvider.tsx';
import type { ApiClient } from '@/lib/api/client.ts';
import { parseWire } from '@/lib/api/client.ts';
import { isAppError } from '@/lib/api/errors.ts';
import {
  AccessResolveResponse,
  HostResponse,
  OkResponse,
  OperationStarted,
  PinVersionResponse,
  type PutSiteRequest,
  RevealResponse,
  SaveVersionResponse,
  SiteResponse,
  TemplateChangeResponse,
  TemplateOperation,
  TemplateVersionsPage,
} from './contracts.ts';

/** Host actions (spec 13 §11.1, `POST /templates/{id}/host/{action}`). */
export type HostAction = 'start' | 'stop' | 'restart';

/** A template field change (`PATCH /templates/{id}`): any `TemplateInput` field but the frozen identity. */
export type TemplatePatch = Readonly<Record<string, unknown>> & {
  readonly confirm_identity_change?: boolean;
};

/** Access tester input. */
export interface AccessProbe {
  readonly principal?: string;
  readonly harness?: string;
  readonly harness_declared?: string;
}

const seg = (value: string | number) => encodeURIComponent(String(value));

/** `true` for the 404 a server answers for a route it does not have yet. */
export function isRouteMissing(error: unknown): boolean {
  return isAppError(error) && error.status === 404 && error.code === 'NOT_FOUND';
}

/** The T1b template calls over one client. */
export function pendingTemplateClient(api: Pick<ApiClient, 'transport'>) {
  const call = async <T>(
    operationId: string,
    method: string,
    path: string,
    schema: z.ZodType<T>,
    options: { readonly body?: unknown; readonly ifMatch?: number } = {},
  ): Promise<T> => {
    const result = await api.transport.request({
      operationId,
      method,
      path,
      ...(options.body !== undefined && { body: options.body }),
      headers: options.ifMatch !== undefined ? { 'If-Match': String(options.ifMatch) } : {},
    });
    return parseWire(schema, result.body, operationId, { strict: false });
  };
  const base = (id: string) => `/templates/${seg(id)}`;
  return {
    patchTemplate: (id: string, patch: TemplatePatch, ifMatch: number) =>
      call('patchTemplate', 'patch', base(id), TemplateChangeResponse, { body: patch, ifMatch }),
    setEnabled: (id: string, enabled: boolean) =>
      call(
        enabled ? 'enableTemplate' : 'disableTemplate',
        'post',
        `${base(id)}/${enabled ? 'enable' : 'disable'}`,
        TemplateChangeResponse,
        { body: {} },
      ),
    putSite: (id: string, site: string, body: PutSiteRequest) =>
      call('putTemplateSite', 'put', `${base(id)}/sites/${seg(site)}`, SiteResponse, { body }),
    deleteSite: (id: string, site: string) =>
      call('deleteTemplateSite', 'delete', `${base(id)}/sites/${seg(site)}`, OkResponse),
    host: (id: string, action: HostAction) =>
      call(`${action}TemplateHost`, 'post', `${base(id)}/host/${action}`, HostResponse, {
        body: {},
      }),
    closeParkedPage: (id: string, targetId: string) =>
      call(
        'closeTemplateParkedPage',
        'post',
        `${base(id)}/host/pages/${seg(targetId)}/close`,
        OkResponse,
        { body: {} },
      ),
    listVersions: (id: string, cursor?: string) =>
      call(
        'listTemplateVersions',
        'get',
        `${base(id)}/versions${cursor === undefined ? '' : `?cursor=${seg(cursor)}`}`,
        TemplateVersionsPage,
      ),
    saveVersion: (id: string) =>
      call('saveTemplateVersion', 'post', `${base(id)}/versions`, SaveVersionResponse, {
        body: {},
      }),
    pinVersion: (id: string, version: number, pinned: boolean) =>
      call(
        'pinTemplateVersion',
        'patch',
        `${base(id)}/versions/${seg(version)}`,
        PinVersionResponse,
        {
          body: { pinned },
        },
      ),
    restoreVersion: (id: string, version: number | 'latest', forceClose: boolean) =>
      call(
        'restoreTemplateVersion',
        'post',
        `${base(id)}/versions/${seg(version)}/restore`,
        OperationStarted,
        { body: { force_close: forceClose } },
      ),
    seed: (id: string, state: unknown, confirm: boolean) =>
      call('seedTemplate', 'post', `${base(id)}/state`, OperationStarted, {
        body: confirm ? { ...(state as object), confirm: true } : state,
      }),
    operation: (operationId: string) =>
      call(
        'getTemplateOperation',
        'get',
        `/templates/operations/${seg(operationId)}`,
        TemplateOperation,
      ),
    resolveAccess: (id: string, probe: AccessProbe) =>
      call('resolveTemplateAccess', 'post', `${base(id)}/access/resolve`, AccessResolveResponse, {
        body: probe,
      }),
    revealDataDir: (id: string) =>
      call('revealTemplateDataDir', 'post', `${base(id)}/data-dir/reveal`, RevealResponse, {
        body: {},
      }),
  };
}

/** The T1b calls for the signed-in operator. */
export type PendingTemplateClient = ReturnType<typeof pendingTemplateClient>;

/** Hook form. */
export function usePendingTemplateApi(): PendingTemplateClient {
  return pendingTemplateClient(useApi());
}

/** @module interface/http/routes/system — system info, config provenance, realtime, log level, degradations (spec 03 §4.7). */

import {
  SetLogLevelRequest,
  SetLogLevelResponse,
  SystemConfigResponse,
  SystemEventsPage,
  SystemEventsQuery,
  SystemInfo,
  SystemRealtimeResponse,
} from '@browserhive/contracts/http';
import { defineRoute, reply } from '../define-route.ts';
import { envelope, pagingOf } from '../serializers/page.ts';
import { configKeysToWire, systemEventToWire } from '../serializers/system.ts';

const tags = ['system'];

/** System routes. */
export const SYSTEM_ROUTES = [
  defineRoute({
    operationId: 'getSystem',
    tags,
    summary:
      'Server facts, runtime, capacity, retention, storage, telemetry and open degradations.',
    request: {},
    responses: { 200: SystemInfo },
    async handler({ services }) {
      return reply(200, await services.systemStatus.snapshot());
    },
  }),
  defineRoute({
    operationId: 'getSystemConfig',
    tags,
    summary: 'Every config key with its value, source and shadowed values (secrets redacted).',
    request: {},
    responses: { 200: SystemConfigResponse },
    async handler({ services }) {
      return reply(200, { keys: configKeysToWire(services.system.configView()) });
    },
  }),
  defineRoute({
    operationId: 'getSystemRealtime',
    tags,
    summary: 'Open realtime connections with topics, screencasts and backpressure counters.',
    request: {},
    responses: { 200: SystemRealtimeResponse },
    async handler({ services }) {
      return reply(200, { connections: [...services.realtime.connections()] });
    },
  }),
  defineRoute({
    operationId: 'setLogLevel',
    tags,
    summary: 'Change the log level spec at runtime (`info,sessions=debug`).',
    request: { body: SetLogLevelRequest },
    responses: { 200: SetLogLevelResponse },
    async handler({ input, services }) {
      return reply(200, { ok: true, effective: services.logLevel.set(input.body.spec) });
    },
  }),
  defineRoute({
    operationId: 'listSystemEvents',
    tags,
    summary: 'Degradations (`resolved=open` by default).',
    request: { query: SystemEventsQuery },
    responses: { 200: SystemEventsPage },
    async handler({ input, services, ctx }) {
      const q = input.query;
      const page = await services.repos.systemEvents.list({
        ...pagingOf(q),
        ...(q.severity !== undefined && { severities: q.severity }),
        ...(q.since !== undefined && { since: q.since }),
        ...(q.resolved === 'open' && { openOnly: true }),
      });
      const items =
        q.resolved === 'resolved' ? page.items.filter((e) => e.resolvedAt !== null) : page.items;
      return reply(
        200,
        envelope({ ...page, items }, systemEventToWire, q, ctx.now, 'last_seen_at'),
      );
    },
  }),
];

/** @module interface/http/routes/session-facts — per-session sub-collections: tool calls, pages, attention, vault access, blocked, screenshots, timeline (spec 03 §4.2). */

import {
  BlockedAttemptsPage,
  BlockedAttemptsQuery,
  ScreenshotsPage,
  SessionAttentionPage,
  SessionAttentionQuery,
  SessionEventParams,
  SessionIdParams,
  SessionPagesPage,
  SessionPagesQuery,
  SessionScreenshotsQuery,
  SessionToolCallsPage,
  SessionToolCallsQuery,
  TimelinePage,
  TimelineQuery,
  ToolCallDetail,
  VaultLogPage,
  VaultLogQuery,
} from '@browserhive/contracts/http';
import { AppError } from '../../../kernel/errors/app-error.ts';
import { defineRoute, reply } from '../define-route.ts';
import {
  blockedQueryToRepo,
  blockedToWire,
  pagesQueryToRepo,
  pageToWire,
  screenshotsQueryToRepo,
  screenshotToWire,
  toolCallsQueryToRepo,
  toolCallToWire,
  vaultAccessToWire,
  vaultLogQueryToRepo,
} from '../serializers/facts.ts';
import {
  operatorRequestQueryToRepo,
  operatorRequestToWire,
} from '../serializers/operator-requests.ts';
import { envelope, pagingOf } from '../serializers/page.ts';
import { timelineItemToWire } from '../serializers/timeline.ts';
import { requireSession } from './common.ts';

const tags = ['sessions'];
const errors = ['SESSION_NOT_FOUND'] as const;

/** Per-session sub-collection routes. */
export const SESSION_FACT_ROUTES = [
  defineRoute({
    operationId: 'listSessionToolCalls',
    tags,
    summary: 'Tool calls of one session (`?expand=detail` adds args/result).',
    request: { params: SessionIdParams, query: SessionToolCallsQuery },
    responses: { 200: SessionToolCallsPage },
    errors,
    async handler({ input, services, ctx }) {
      const known = await requireSession(services, input.params.session_id);
      const detail = input.query.expand === 'detail';
      const page = await services.repos.toolCalls.listBySession(
        known.id,
        toolCallsQueryToRepo(input.query, known.id),
      );
      return reply(
        200,
        envelope(page, (row) => toolCallToWire(row, detail), input.query, ctx.now, 'ts'),
      );
    },
  }),
  defineRoute({
    operationId: 'getSessionToolCall',
    tags,
    summary: 'One tool call with args, result and its screenshot.',
    request: { params: SessionEventParams },
    responses: { 200: ToolCallDetail },
    errors: ['SESSION_NOT_FOUND', 'NOT_FOUND'],
    async handler({ input, services }) {
      const known = await requireSession(services, input.params.session_id);
      const row = await services.repos.toolCalls.get(input.params.event_id);
      if (row === null || row.sessionId !== known.id) throw new AppError('NOT_FOUND', {});
      const shot = await services.repos.screenshots.get(row.eventId);
      const base = toolCallToWire(row, true);
      return reply(200, {
        ...base,
        args_json: row.args,
        result_text: row.resultText,
        ...(shot !== null && { screenshot: screenshotToWire(shot) }),
      });
    },
  }),
  defineRoute({
    operationId: 'listSessionPages',
    tags,
    summary: 'Pages visited by one session.',
    request: { params: SessionIdParams, query: SessionPagesQuery },
    responses: { 200: SessionPagesPage },
    errors,
    async handler({ input, services, ctx }) {
      const known = await requireSession(services, input.params.session_id);
      const page = await services.repos.pages.list(pagesQueryToRepo(input.query, known.id));
      return reply(200, envelope(page, pageToWire, input.query, ctx.now, 'ts'));
    },
  }),
  defineRoute({
    operationId: 'listSessionAttention',
    tags,
    summary: 'Attention requests of one session.',
    request: { params: SessionIdParams, query: SessionAttentionQuery },
    responses: { 200: SessionAttentionPage },
    errors,
    async handler({ input, services, ctx }) {
      const known = await requireSession(services, input.params.session_id);
      const page = await services.attention.history(
        operatorRequestQueryToRepo(input.query, known.id),
      );
      return reply(200, envelope(page, operatorRequestToWire, input.query, ctx.now, 'created_at'));
    },
  }),
  defineRoute({
    operationId: 'listSessionVaultAccess',
    tags,
    summary: 'Vault access audit rows of one session.',
    request: { params: SessionIdParams, query: VaultLogQuery },
    responses: { 200: VaultLogPage },
    errors,
    async handler({ input, services, ctx }) {
      const known = await requireSession(services, input.params.session_id);
      const page = await services.vault.accessLog(vaultLogQueryToRepo(input.query, known.id));
      return reply(200, envelope(page, vaultAccessToWire, input.query, ctx.now, 'ts'));
    },
  }),
  defineRoute({
    operationId: 'listSessionBlocked',
    tags,
    summary: 'Blocked requests of one session.',
    request: { params: SessionIdParams, query: BlockedAttemptsQuery },
    responses: { 200: BlockedAttemptsPage },
    errors,
    async handler({ input, services, ctx }) {
      const known = await requireSession(services, input.params.session_id);
      const page = await services.repos.blocklistAudit.list(
        blockedQueryToRepo(input.query, known.id),
      );
      return reply(200, envelope(page, blockedToWire, input.query, ctx.now, 'ts'));
    },
  }),
  defineRoute({
    operationId: 'listSessionScreenshots',
    tags,
    summary: 'Screenshots of one session (image URLs accept grants).',
    request: { params: SessionIdParams, query: SessionScreenshotsQuery },
    responses: { 200: ScreenshotsPage },
    errors,
    async handler({ input, services, ctx }) {
      const known = await requireSession(services, input.params.session_id);
      const page = await services.repos.screenshots.listBySession(
        known.id,
        screenshotsQueryToRepo(input.query),
      );
      return reply(200, envelope(page, screenshotToWire, input.query, ctx.now, 'ts'));
    },
  }),
  defineRoute({
    operationId: 'getSessionTimeline',
    tags,
    summary: 'Merged timeline of tool calls, pages, attention, vault and blocked rows.',
    request: { params: SessionIdParams, query: TimelineQuery },
    responses: { 200: TimelinePage },
    errors,
    async handler({ input, services, ctx }) {
      const known = await requireSession(services, input.params.session_id);
      const query = input.query;
      const page = await services.analytics.timeline(known.id, {
        ...pagingOf(query),
        errorsOnly: query.errors_only,
        ...(query.kinds !== undefined && { kinds: query.kinds }),
        ...(query.q !== undefined && { q: query.q }),
      });
      return reply(200, envelope(page, timelineItemToWire, query, ctx.now, 'ts'));
    },
  }),
];

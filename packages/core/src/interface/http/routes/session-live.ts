/** @module interface/http/routes/session-live — viewport and operator input over REST (the same inputs as the WS channel, reachable with curl; spec 03 §4.2). */

import {
  SessionIdParams,
  SessionInputRequest,
  SessionInputResponse,
  SetViewportRequest,
  SetViewportResponse,
} from '@browserhive/contracts/http';
import { AppError, isAppError } from '../../../kernel/errors/app-error.ts';
import { defineRoute, reply } from '../define-route.ts';
import { requireSession } from './common.ts';

const tags = ['sessions'];

/** Live-control routes. */
export const SESSION_LIVE_ROUTES = [
  defineRoute({
    operationId: 'setSessionViewport',
    tags,
    summary: 'Resize the active page viewport; not attention-gated (D-10).',
    request: { params: SessionIdParams, body: SetViewportRequest },
    responses: { 200: SetViewportResponse },
    errors: ['SESSION_NOT_FOUND', 'SESSION_NOT_AVAILABLE'],
    async handler({ input, services }) {
      const known = await requireSession(services, input.params.session_id);
      const size = await services.live.setViewport(known.id, input.body.width, input.body.height);
      const clamped = size.width !== input.body.width || size.height !== input.body.height;
      return reply(200, {
        ok: true,
        width: size.width,
        height: size.height,
        ...(clamped && { clamped }),
      });
    },
  }),
  defineRoute({
    operationId: 'sendSessionInput',
    tags,
    summary:
      'Operator takeover input; each input re-checks the open takeover attention request (per-item results).',
    request: { params: SessionIdParams, body: SessionInputRequest },
    responses: { 200: SessionInputResponse },
    errors: ['SESSION_NOT_FOUND', 'INPUT_NOT_PERMITTED'],
    async handler({ input, services, principal }) {
      const known = await requireSession(services, input.params.session_id);
      // A takeover route is never public, so the principal is always present here.
      const actor = { principalId: principal?.subject ?? 'unknown', via: 'rest' } as const;
      if (!services.attention.isInputPermitted(known.id, 'input')) {
        throw new AppError(
          'INPUT_NOT_PERMITTED',
          { session_id: known.id },
          {
            publicMessage: `Input is not permitted on session '${known.id}': no takeover attention request is open.`,
          },
        );
      }
      let accepted = 0;
      const rejected: {
        index: number;
        code: 'INPUT_NOT_PERMITTED' | 'SESSION_NOT_AVAILABLE' | 'INPUT_FAILED';
      }[] = [];
      for (const [index, item] of input.body.inputs.entries()) {
        if (!services.attention.isInputPermitted(known.id, 'input')) {
          rejected.push({ index, code: 'INPUT_NOT_PERMITTED' });
          continue;
        }
        try {
          await services.live.sendInput(known.id, item, actor);
          accepted += 1;
        } catch (error) {
          const code =
            isAppError(error) &&
            (error.code === 'SESSION_NOT_AVAILABLE' || error.code === 'SESSION_NOT_FOUND')
              ? 'SESSION_NOT_AVAILABLE'
              : 'INPUT_FAILED';
          rejected.push({ index, code });
        }
      }
      return reply(200, { accepted, rejected });
    },
  }),
];

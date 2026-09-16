/** @module interface/http/serializers/operator-requests — operator request rows and history queries (spec 03 §4.4, D-15). */

import type {
  AttentionQuery,
  OperatorRequestRow,
  SessionAttentionQuery,
  VaultConfirmQuery,
} from '@browserhive/contracts/http';
import type { z } from 'zod';
import { toOperatorRequestRow } from '../../../domain/operator-requests/wire.ts';
import type { OperatorRequestListRow } from '../../../ports/persistence/operator-requests.ts';
import type { OperatorRequestListQuery } from '../../../ports/persistence/queries.ts';
import { pagingOf } from './page.ts';

/** One operator request (both kinds) as the wire row. */
export function operatorRequestToWire(
  row: OperatorRequestListRow,
): z.input<typeof OperatorRequestRow> {
  return toOperatorRequestRow(row, row.sessionSlug);
}

/** `GET /attention`, `GET /sessions/{id}/attention`, `GET /vault/confirm` query → broker history query. */
export function operatorRequestQueryToRepo(
  query:
    | z.output<typeof AttentionQuery>
    | z.output<typeof SessionAttentionQuery>
    | z.output<typeof VaultConfirmQuery>,
  sessionId?: string,
): OperatorRequestListQuery {
  const session = sessionId ?? ('session_id' in query ? query.session_id : undefined);
  return {
    ...pagingOf(query),
    sort: query.sort,
    ...(session !== undefined && { sessionId: session }),
    ...(query.status !== undefined && { statuses: query.status }),
    ...('mode' in query && query.mode !== undefined && { modes: query.mode }),
    ...('q' in query && query.q !== undefined && { q: query.q }),
    ...('since' in query && query.since !== undefined && { since: query.since }),
    ...('until' in query && query.until !== undefined && { until: query.until }),
  };
}

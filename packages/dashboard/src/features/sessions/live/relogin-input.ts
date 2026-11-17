/** @module features/sessions/live/relogin-input — whether the live view of a session takes input without an attention request: the maintenance session of a template re-login signed in through the live view (spec 13 §8.4, review #81 M-2), while that re-login is open; the server's input gate allows it to operators with `templates:login` and re-checks every input */
import type { SessionSummary } from '@browserhive/contracts/http';
import { useQueryClient } from '@tanstack/react-query';
import { useTopic } from '@/app/providers/SocketProvider.tsx';
import { useTemplateDetail } from '@/features/templates/api.ts';
import { liveViewSession } from '@/features/templates/LiveViewSignIn.tsx';
import { applyTemplateEvent, TEMPLATES_TOPIC } from '@/features/templates/live.ts';

/** `open`: input is allowed for this session's re-login; `known`: `false` until the template answered. */
export interface ReloginInput {
  readonly open: boolean;
  readonly known: boolean;
}

/** The template of a live maintenance session, or `undefined`. */
function maintenanceTemplate(session: SessionSummary | undefined): string | undefined {
  if (session?.live !== true || session.template?.mode !== 'maintenance') return undefined;
  return session.template.template_id ?? undefined;
}

/** Reads the session's template (kept current over the `templates` topic) when it is a maintenance session. */
export function useReloginInput(session: SessionSummary | undefined): ReloginInput {
  const templateId = maintenanceTemplate(session);
  const qc = useQueryClient();
  const detail = useTemplateDetail(templateId);
  useTopic(templateId === undefined ? null : TEMPLATES_TOPIC, (event) =>
    applyTemplateEvent(qc, event),
  );
  if (templateId === undefined || session === undefined) return { open: false, known: true };
  return {
    open: liveViewSession(detail.data?.relogin ?? null) === session.session_id,
    known: !detail.isPending,
  };
}

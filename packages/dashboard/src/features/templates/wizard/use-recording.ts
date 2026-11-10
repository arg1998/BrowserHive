/** @module features/templates/wizard/use-recording — the template's open recording window, if any: the live maintenance sessions of the template (`GET /sessions?template=…&maintenance=only`), re-read every few seconds while the sign-in step is open */
import { useQuery } from '@tanstack/react-query';
import { useApi } from '@/app/providers/AuthProvider.tsx';
import { keys } from '@/lib/api/keys.ts';
import { SIGN_IN_POLL_MS } from '../api.ts';
import { recordingSessionOf } from './sign-in-model.ts';

/** The recording session (or `null`), and whether that is known yet. */
export function useRecordingSession(templateId: string) {
  const api = useApi();
  const query = { template: [templateId], maintenance: 'only', view: 'live', limit: 10 } as const;
  const sessions = useQuery({
    queryKey: keys.sessions.list({ ...query, purpose: 'recording' }),
    queryFn: () => api.listSessions({ query }),
    refetchInterval: SIGN_IN_POLL_MS,
  });
  return {
    session: recordingSessionOf(sessions.data?.data ?? []),
    known: sessions.data !== undefined,
    refetch: sessions.refetch,
  };
}

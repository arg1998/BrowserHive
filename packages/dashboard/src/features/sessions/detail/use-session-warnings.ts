/** @module features/sessions/detail/use-session-warnings — subscribe `session:<id>` (bridge patches detail/timeline) and collect `session.warning` events for the banner */

import { SessionId } from '@browserhive/contracts/ids';
import { sessionTopic } from '@browserhive/contracts/ws';
import { useCallback, useState } from 'react';
import { useTopic } from '@/app/providers/SocketProvider.tsx';

/** Topic for a raw route id (`null` when the id is malformed). */
export function sessionTopicFor(id: string): string | null {
  const parsed = SessionId.safeParse(id);
  return parsed.success ? sessionTopic(parsed.data) : null;
}

/** A warning raised on `session:<id>`. */
export interface SessionWarning {
  readonly code: string;
  readonly message: string;
}

/** Warnings state + dismiss. */
export function useSessionWarnings(id: string) {
  const [warnings, setWarnings] = useState<readonly SessionWarning[]>([]);
  useTopic(sessionTopicFor(id), (event) => {
    if (event.type !== 'session.warning') return;
    setWarnings((current) => [
      ...current.filter((w) => w.code !== event.code),
      { code: event.code, message: event.message },
    ]);
  });
  const dismiss = useCallback((code: string) => {
    setWarnings((current) => current.filter((w) => w.code !== code));
  }, []);
  return { warnings, dismiss };
}

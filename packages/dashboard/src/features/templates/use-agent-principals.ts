/** @module features/templates/use-agent-principals — the principals of the issued agent tokens, offered as suggestions wherever a template's principals are typed */
import { useQuery } from '@tanstack/react-query';
import { useApi } from '@/app/providers/AuthProvider.tsx';
import { keys } from '@/lib/api/keys.ts';

/** Agent principals of the issued tokens, offered as suggestions. */
export function useAgentPrincipals(enabled: boolean): readonly string[] {
  const api = useApi();
  const tokens = useQuery({
    queryKey: keys.auth.tokens(),
    queryFn: () => api.listTokens(),
    enabled,
    staleTime: 60_000,
  });
  const subjects = (tokens.data?.data ?? [])
    .filter((t) => t.owner_kind === 'agent')
    .map((t) => t.subject);
  return [...new Set(subjects)];
}

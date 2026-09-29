/** @module features/system/api — system queries: status (`GET /system`, patched by the `system` topic), config with provenance, realtime connections, MCP connections, degradations history, health (a degraded 503 still yields its body) (spec 04 §12.10, spec 03 §4.7) */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '@/app/providers/AuthProvider.tsx';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { isAppError, toAppError } from '@/lib/api/errors.ts';
import { keys } from '@/lib/api/keys.ts';

/** `GET /system`. */
export function useSystem() {
  const api = useApi();
  return useQuery({ queryKey: keys.system.status(), queryFn: () => api.getSystem() });
}

/** `GET /system/config`. */
export function useConfig(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.system.config(),
    queryFn: () => api.getSystemConfig(),
    enabled,
  });
}

/** `GET /system/realtime`. */
export function useRealtime(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.system.realtime(),
    queryFn: () => api.getSystemRealtime(),
    enabled,
  });
}

/** `GET /system/mcp/connections` (live first, then recent). */
export function useMcpConnections(
  enabled = true,
  paging: { readonly page: number; readonly pageSize: number } = { page: 1, pageSize: 10 },
) {
  const api = useApi();
  const query = {
    limit: paging.pageSize,
    offset: (Math.max(1, paging.page) - 1) * paging.pageSize,
  } as const;
  return useQuery({
    queryKey: keys.system.mcpConnections(query),
    queryFn: () => api.listMcpConnections({ query }),
    placeholderData: keepPreviousData,
    enabled,
  });
}

/** `GET /system/events?resolved=all` (degradations with their resolve state). */
export function useSystemEvents(enabled = true) {
  const api = useApi();
  const query = { resolved: 'all', limit: 50 } as const;
  return useQuery({
    queryKey: keys.system.events(query),
    queryFn: () => api.listSystemEvents({ query }),
    enabled,
  });
}

/** `GET /health`. A 503 (degraded, starting, stopping) is not retried: its body is read by `readHealth`. */
export function useHealth(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.health(),
    queryFn: () => api.getHealth(),
    enabled,
    retry: (count, error) => !(isAppError(error) && error.status === 503) && count < 2,
  });
}

/** `true` when the error is an authorization refusal. */
export function isForbiddenError(error: unknown): boolean {
  return isAppError(error) && error.status === 403;
}

/** `GET /system/public-url` (cached server-side for 60 s; `refresh` runs the check now). */
export function usePublicUrl() {
  const api = useApi();
  return useQuery({ queryKey: keys.publicUrl(), queryFn: () => api.getPublicUrlStatus() });
}

/** Re-runs the `publicUrl` check. */
export function useRefreshPublicUrl() {
  const api = useApi();
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: () => api.getPublicUrlStatus({ query: { refresh: true } }),
    onSuccess: (status) => queryClient.setQueryData(keys.publicUrl(), status),
    onError: (error) => toast.fromError(toAppError(error), 'Could not check the public address'),
  });
}

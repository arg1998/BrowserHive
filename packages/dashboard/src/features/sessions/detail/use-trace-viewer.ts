/** @module features/sessions/detail/use-trace-viewer — trace viewer availability hints and the grant-minting opener for `/trace-viewer/index.html?trace=…` (spec 04 §12.3.5) */
import type { SessionDetail } from '@browserhive/contracts/http';
import { useCallback, useState } from 'react';
import { useApi } from '@/app/providers/AuthProvider.tsx';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { toAppError } from '@/lib/api/errors.ts';

/** Why the viewer cannot open, or the enabled hint. */
export function traceViewerHint(detail: SessionDetail): {
  readonly enabled: boolean;
  readonly hint: string;
} {
  if (!detail.trace.enabled) {
    return {
      enabled: false,
      hint: 'Tracing is disabled — start the server with --trace or --admin.',
    };
  }
  if (detail.session.live) {
    return { enabled: false, hint: 'The trace is written when the session closes.' };
  }
  if (!detail.trace.viewer_available) {
    return { enabled: false, hint: 'Playwright Trace Viewer bundle was not found on the server.' };
  }
  return { enabled: true, hint: 'Open this session’s trace in the Playwright Trace Viewer' };
}

/** Viewer URL for an authenticated trace URL. */
export function traceViewerUrl(traceUrl: string): string {
  return `/trace-viewer/index.html?trace=${encodeURIComponent(traceUrl)}`;
}

/** Mint a grant and open the viewer in a new tab; also exposes the plain download URL. */
export function useTraceViewer(sessionId: string) {
  const api = useApi();
  const toast = useToast();
  const [opening, setOpening] = useState(false);
  const downloadUrl = api.url('getTraceZip', { session_id: sessionId });
  const open = useCallback(async () => {
    setOpening(true);
    try {
      const grant = await api.createGrant({ body: { route: 'trace', resource_id: sessionId } });
      const traceUrl = api.url('getTraceZip', { session_id: sessionId }, { grant: grant.grant });
      const absolute = new URL(traceUrl, window.location.origin).toString();
      window.open(traceViewerUrl(absolute), '_blank', 'noopener');
    } catch (error) {
      toast.fromError(toAppError(error), 'Could not open the trace viewer');
    } finally {
      setOpening(false);
    }
  }, [api, sessionId, toast]);
  return { open, opening, downloadUrl };
}

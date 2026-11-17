/** @module features/templates/LiveViewSignIn — signing in again through the live view (spec 13 §8.4, review #81 M-2): when the template's browser cannot show a window here (a headless template already running, or no display on the server) the re-login's maintenance session streams in its live view, where input is open to operators with `templates:login` while the re-login runs; the words and the **Sign in in the live view** link, and the hook behind **Show window** that goes there for such a re-login */
import type { ReloginView, TemplateDetailResponse } from '@browserhive/contracts/http';
import { Link, useNavigate } from '@tanstack/react-router';
import { useApi } from '@/app/providers/AuthProvider.tsx';
import { buttonVariants } from '@/components/ui/button.tsx';
import { ICONS } from '@/lib/icons.ts';
import { cn } from '@/lib/utils.ts';
import { useTemplateHealth } from './api-health.ts';

/** Where to sign in when the browser has no window to show. */
export const LIVE_VIEW_TEXT =
  'This template’s browser has no window to show here: sign in through the live view. Agents wait only while you type.';

/**
 * Whether a window re-login will sign in through the live view, as far as the page can tell: a
 * headless template whose browser is already running (a stopped one starts headed). A server
 * without a display also answers `live_view`, which only the start's answer shows.
 */
export function expectsLiveView(
  detail: Pick<TemplateDetailResponse, 'template' | 'host'>,
): boolean {
  return detail.template.headless && detail.host.state !== 'stopped';
}

/** The re-login's live view when it is the place to sign in (an open `live_view` re-login), else `null`. */
export function liveViewSession(relogin: ReloginView | null): string | null {
  return relogin !== null &&
    relogin.state === 'open' &&
    relogin.sign_in_via === 'live_view' &&
    relogin.session_id !== null
    ? relogin.session_id
    : null;
}

/** The live view of a maintenance session, with input armed. */
export function LiveViewLink({
  sessionId,
  size = 'sm',
  className,
}: {
  readonly sessionId: string;
  readonly size?: 'xs' | 'sm';
  readonly className?: string;
}) {
  return (
    <Link
      to="/sessions/$id"
      params={{ id: sessionId }}
      search={{ live: 1, takeover: 1 }}
      className={cn(buttonVariants({ size }), className)}
    >
      <ICONS.live aria-hidden="true" />
      Sign in in the live view
    </Link>
  );
}

/**
 * **Show window**: raises the window, or opens a queued one. A re-login signed in through the live
 * view goes there instead (after opening it when it was queued).
 */
export function useShowWindow(templateId: string, relogin: ReloginView | null) {
  const health = useTemplateHealth(templateId);
  const api = useApi();
  const navigate = useNavigate();
  const goLive = (sessionId: string) =>
    void navigate({
      to: '/sessions/$id',
      params: { id: sessionId },
      search: { live: 1, takeover: 1 },
    });
  const show = () => {
    const live = liveViewSession(relogin);
    if (live !== null) {
      goLive(live);
      return;
    }
    health.show.mutate(undefined, {
      onSuccess: async (result) => {
        if (result.window !== 'relogin') return;
        const fresh = await api
          .getTemplate({ params: { template_id: templateId } })
          .catch(() => null);
        const opened = liveViewSession(fresh?.relogin ?? null);
        if (opened !== null) goLive(opened);
      },
    });
  };
  return { show, pending: health.show.isPending };
}

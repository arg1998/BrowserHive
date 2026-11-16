/** @module features/templates/detail/ActivityTab — the Activity tab (spec 13 §11.4): where the history of sign-in checks and site-rule decisions will be listed; it fills once BrowserHive runs scheduled sign-in checks (T2) and site rules (T3a) */
import { EmptyState } from '@/components/shared/EmptyState.tsx';

/** Activity tab. */
export function ActivityTab() {
  return (
    <EmptyState
      kind="zero-data"
      variant="panel"
      icon="activity"
      title="A history of sign-in checks will appear here"
      description="Once BrowserHive checks the sites on a schedule, each result (signed in, signed out, check needed) is listed here, newest first, with the requests a site’s rules held or blocked. The Sites tab shows each site’s current state."
    />
  );
}

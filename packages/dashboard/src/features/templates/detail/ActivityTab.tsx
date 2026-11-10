/** @module features/templates/detail/ActivityTab — the Activity tab (spec 13 §11.4): sign-in checks and site rule hits of the template, filterable; empty until the server reports them */
import { EmptyState } from '@/components/shared/EmptyState.tsx';

/** Activity tab. */
export function ActivityTab() {
  return (
    <EmptyState
      kind="zero-data"
      variant="panel"
      icon="activity"
      title="No checks or rule hits yet"
      description="Each sign-in check of a site (signed in, signed out, check needed) and each request a site rule held or blocked is listed here, newest first."
    />
  );
}

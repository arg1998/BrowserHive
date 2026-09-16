/** @module features/sessions/list/session-empty — the three `/sessions` empty states (spec 04 §12.2, §11) */
import { EmptyState } from '@/components/shared/EmptyState.tsx';
import { buttonVariants } from '@/components/ui/button.tsx';
import { hasSessionFilters, type SessionsSearch } from '../search.ts';

/** Docs link for the zero-data CTA. */
export const CONNECT_DOCS_URL = 'https://github.com/browserhive/browserhive#connect-an-mcp-client';

/** Empty state for the current search. */
export function SessionsEmpty({
  search,
  onClear,
}: {
  readonly search: SessionsSearch;
  readonly onClear: () => void;
}) {
  if (search.view === 'archived' && !hasSessionFilters({ ...search, view: undefined })) {
    return (
      <EmptyState
        kind="zero-data"
        icon="archive"
        title="No archived sessions"
        description="Archived sessions are hidden from the main list and land here. Select rows and Archive to move them."
      />
    );
  }
  if (hasSessionFilters(search)) {
    return (
      <EmptyState
        kind="zero-results"
        icon="search"
        title="No sessions match these filters"
        description="Adjust the status, owner, channel, or search to widen the view."
        onClear={onClear}
      />
    );
  }
  return (
    <EmptyState
      kind="zero-data"
      icon="sessions"
      title="No sessions yet"
      description="Sessions appear here as soon as a browser context is leased."
      action={
        <a
          href={CONNECT_DOCS_URL}
          target="_blank"
          rel="noreferrer"
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
        >
          Connect an MCP client
        </a>
      }
    />
  );
}

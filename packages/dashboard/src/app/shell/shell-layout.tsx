/** @module app/shell/shell-layout — page layout modes: the default document-scrolling page, or a fixed-height workspace whose panes scroll themselves (`useWorkspaceLayout`) */
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';

/** Layout of the current page. */
export type PageLayout = 'document' | 'workspace';

interface ShellLayoutValue {
  readonly layout: PageLayout;
  readonly claim: () => () => void;
}

const ShellLayoutContext = createContext<ShellLayoutValue>({
  layout: 'document',
  claim: () => () => undefined,
});

/** Owns the layout mode; mounted once by `AppShell`. */
export function ShellLayoutProvider({ children }: { readonly children: ReactNode }) {
  const [claims, setClaims] = useState(0);
  const value = useMemo<ShellLayoutValue>(
    () => ({
      layout: claims > 0 ? 'workspace' : 'document',
      claim: () => {
        setClaims((n) => n + 1);
        return () => setClaims((n) => Math.max(0, n - 1));
      },
    }),
    [claims],
  );
  return <ShellLayoutContext.Provider value={value}>{children}</ShellLayoutContext.Provider>;
}

/** The current layout mode (the shell reads it to size `main`). */
export function usePageLayout(): PageLayout {
  return useContext(ShellLayoutContext).layout;
}

/**
 * Opt the current page into the fixed-height workspace layout while `active`: `main` becomes
 * exactly the viewport height under the topbar (`--workspace-height`), the document stops
 * scrolling, and the page's own panes (`min-h-0 overflow-y-auto`) are the only scrollers.
 * Render the page root as `flex min-h-0 flex-1 flex-col`.
 */
export function useWorkspaceLayout(active = true): void {
  const { claim } = useContext(ShellLayoutContext);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `claim` identity changes with the count; re-claiming on every change would loop
  useEffect(() => (active ? claim() : undefined), [active]);
}

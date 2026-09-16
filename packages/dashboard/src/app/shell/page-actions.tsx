/** @module app/shell/page-actions — page-contributed command palette actions: `usePageActions([...])` registers them while the page is mounted */
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { IconName } from '@/lib/icons.ts';

/** One action a page offers in the palette ("This page" section). */
export interface PageAction {
  /** Stable id, unique on the page (`session.live.toggle`). */
  readonly id: string;
  readonly label: string;
  readonly icon: IconName;
  /** Right-aligned hint (shortcut or short context). */
  readonly hint?: string;
  readonly keywords?: readonly string[];
  readonly run: () => void;
}

interface Registry {
  readonly actions: readonly PageAction[];
  readonly register: (owner: symbol, actions: readonly PageAction[]) => () => void;
}

const PageActionsContext = createContext<Registry>({
  actions: [],
  register: () => () => undefined,
});

/** Holds the actions of the mounted page(s); mounted once by `AppShell`. */
export function PageActionsProvider({ children }: { readonly children: ReactNode }) {
  const [owners, setOwners] = useState<ReadonlyMap<symbol, readonly PageAction[]>>(new Map());
  const value = useMemo<Registry>(
    () => ({
      actions: [...owners.values()].flat(),
      register: (owner, actions) => {
        setOwners((prev) => new Map(prev).set(owner, actions));
        return () =>
          setOwners((prev) => {
            const next = new Map(prev);
            next.delete(owner);
            return next;
          });
      },
    }),
    [owners],
  );
  return <PageActionsContext.Provider value={value}>{children}</PageActionsContext.Provider>;
}

/**
 * Offer actions in the command palette while this component is mounted. Pass a memoised array
 * (or one whose ids/labels are stable); `run` may close over fresh state.
 *
 * ```tsx
 * usePageActions(useMemo(() => [
 *   { id: 'session.live', label: live ? 'Hide live view' : 'Show live view', icon: 'play', hint: 'L', run: toggleLive },
 * ], [live, toggleLive]));
 * ```
 */
export function usePageActions(actions: readonly PageAction[]): void {
  const { register } = useContext(PageActionsContext);
  const owner = useRef(Symbol('page-actions')).current;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `register` changes identity whenever any page registers; re-registering on that would loop
  useEffect(() => register(owner, actions), [actions, owner]);
}

/** Actions of the current page (palette). */
export function usePageActionsList(): readonly PageAction[] {
  return useContext(PageActionsContext).actions;
}

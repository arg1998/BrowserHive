/** @module app/shell/page-crumb — a page names its own object for the breadcrumb and `document.title` (a template's display name instead of "Template"): `usePageCrumb(label)` while mounted; route `crumb` functions stay the fallback (spec 04 §6.1–§6.2) */
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';

interface PageCrumb {
  readonly label: string | null;
  readonly set: (label: string | null) => void;
}

const PageCrumbContext = createContext<PageCrumb>({ label: null, set: () => undefined });

/** Holds the mounted page's label; mounted once by `AppShell`. */
export function PageCrumbProvider({ children }: { readonly children: ReactNode }) {
  const [label, set] = useState<string | null>(null);
  const value = useMemo(() => ({ label, set }), [label]);
  return <PageCrumbContext.Provider value={value}>{children}</PageCrumbContext.Provider>;
}

/** Name the current page's object (`null` while it loads: the route's crumb shows meanwhile). */
export function usePageCrumb(label: string | null): void {
  const { set } = useContext(PageCrumbContext);
  useEffect(() => {
    set(label);
    return () => set(null);
  }, [label, set]);
}

/** The label the mounted page set, if any (the topbar's leaf crumb and the document title). */
export function usePageCrumbLabel(): string | null {
  return useContext(PageCrumbContext).label;
}

/** The leaf crumb and title with the page's own label applied (pure, tested). */
export function withPageCrumb<C extends { readonly label: string }>(
  identity: { readonly title: string; readonly crumbs: readonly C[] },
  label: string | null,
): { readonly title: string; readonly crumbs: readonly C[] } {
  if (label === null || identity.crumbs.length === 0) return identity;
  const last = identity.crumbs[identity.crumbs.length - 1] as C;
  return { title: label, crumbs: [...identity.crumbs.slice(0, -1), { ...last, label }] };
}

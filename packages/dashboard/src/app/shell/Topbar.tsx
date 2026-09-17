/** @module app/shell/Topbar — 56px sticky bar: breadcrumbs on object pages only, search field that opens the palette, health, bell, theme menu, account; document title */
import { Link } from '@tanstack/react-router';
import { Fragment, useEffect } from 'react';
import { BrandMark } from '@/components/shared/brand-mark.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Kbd } from '@/components/ui/kbd.tsx';
import { Hint } from '@/components/ui/tooltip.tsx';
import { ICONS } from '@/lib/icons.ts';
import { formatCombo } from '@/lib/keyboard.ts';
import { HealthPill } from './HealthPill.tsx';
import { HelpMenu } from './HelpMenu.tsx';
import { NotificationBell } from './NotificationBell.tsx';
import { PrincipalMenu } from './PrincipalMenu.tsx';
import { isMacLike } from './platform.ts';
import type { ShellBand } from './sidebar-state.ts';
import { ThemeMenu } from './ThemeMenu.tsx';
import { usePageIdentity } from './use-route-table.ts';

/** Topbar. */
export function Topbar({
  band,
  onOpenDrawer,
  onOpenPalette,
  onOpenKeyboardMap,
}: {
  readonly band: ShellBand;
  readonly onOpenDrawer: () => void;
  readonly onOpenPalette: () => void;
  readonly onOpenKeyboardMap: () => void;
}) {
  const { title, crumbs, objectPage } = usePageIdentity();
  useEffect(() => {
    document.title = `${title} · BrowserHive`;
  }, [title]);
  const MenuIcon = ICONS.menu;
  const SearchIcon = ICONS.search;
  const Separator = ICONS.chevronRight;
  const compact = band === 'sm';
  const paletteShortcut = formatCombo('mod+k', isMacLike());
  return (
    <header className="sticky top-0 z-(--z-topbar) flex h-(--topbar-height) shrink-0 items-center gap-2 border-b bg-background/85 px-gutter backdrop-blur-md supports-[not(backdrop-filter:blur(0))]:bg-background">
      {compact ? (
        <>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Open navigation"
            className="-ml-2"
            onClick={onOpenDrawer}
          >
            <MenuIcon aria-hidden="true" className="size-5" />
          </Button>
          <Link
            to="/overview"
            aria-label="BrowserHive overview"
            className="flex size-10 items-center justify-center rounded-md"
          >
            <BrandMark className="size-6" />
          </Link>
        </>
      ) : null}
      <div className="flex min-w-0 flex-1 items-center">
        {objectPage && !compact ? (
          <nav aria-label="Breadcrumb" className="min-w-0">
            <ol className="flex min-w-0 items-center gap-1.5 text-base">
              {crumbs.map((crumb, index) => {
                const last = index === crumbs.length - 1;
                return (
                  <Fragment key={crumb.to}>
                    {index > 0 ? (
                      <li aria-hidden="true" className="flex shrink-0">
                        <Separator className="size-3.5 text-subtle-foreground" />
                      </li>
                    ) : null}
                    <li className={last ? 'min-w-0' : 'shrink-0'}>
                      {last ? (
                        <span
                          className="block truncate font-medium text-foreground"
                          aria-current="page"
                        >
                          {crumb.label}
                        </span>
                      ) : (
                        <Link
                          to={crumb.to}
                          className="rounded-sm text-muted-foreground transition-colors hover:text-foreground"
                        >
                          {crumb.label}
                        </Link>
                      )}
                    </li>
                  </Fragment>
                );
              })}
            </ol>
          </nav>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {compact ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Search"
            onClick={onOpenPalette}
          >
            <SearchIcon aria-hidden="true" />
          </Button>
        ) : (
          <button
            type="button"
            onClick={onOpenPalette}
            aria-label={`Search sessions and pages (${paletteShortcut})`}
            className="mr-2 flex h-9 w-56 cursor-pointer items-center gap-2 rounded-md border border-input bg-card px-3 text-base text-subtle-foreground shadow-xs transition-colors hover:border-border-strong hover:text-muted-foreground lg:w-72 dark:bg-white/[0.03]"
          >
            <SearchIcon aria-hidden="true" className="size-4 shrink-0" />
            <span className="flex-1 truncate text-left">Search sessions, pages…</span>
            <Kbd>{paletteShortcut}</Kbd>
          </button>
        )}
        <HealthPill compact={band === 'sm' || band === 'md'} />
        <NotificationBell />
        <HelpMenu onOpenKeyboardMap={onOpenKeyboardMap} />
        <ThemeMenu />
        <PrincipalMenu
          compact={band !== 'wide' && band !== 'lg'}
          onOpenKeyboardMap={onOpenKeyboardMap}
        />
      </div>
    </header>
  );
}

/** Kept for callers that want a tooltip-wrapped icon action in the topbar. */
export function TopbarIconButton({
  label,
  shortcut,
  onClick,
  children,
}: {
  readonly label: string;
  readonly shortcut?: string;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <Hint label={label} shortcut={shortcut}>
      <Button type="button" variant="ghost" size="icon" aria-label={label} onClick={onClick}>
        {children}
      </Button>
    </Hint>
  );
}

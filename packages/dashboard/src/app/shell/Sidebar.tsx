/** @module app/shell/Sidebar — drawer under 768px; above it a 240px sidebar or a 56px rail the operator pins (⌘/Ctrl+B, header button), with a fixed-position hover-peek overlay that never reflows the page */

import { useRouterState } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useShortcut } from '@/app/providers/KeyboardProvider.tsx';
import { BrandMark } from '@/components/shared/brand-mark.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Kbd } from '@/components/ui/kbd.tsx';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet.tsx';
import { Hint } from '@/components/ui/tooltip.tsx';
import { ICONS } from '@/lib/icons.ts';
import { formatCombo } from '@/lib/keyboard.ts';
import { cn } from '@/lib/utils.ts';
import { isMacLike } from './platform.ts';
import { SidebarNav, useNavSignals } from './SidebarNav.tsx';
import { type ShellBand, useHoverPeek, useSidebarPreference } from './sidebar-state.ts';

/** Props. */
export interface SidebarProps {
  readonly band: ShellBand;
  readonly drawerOpen: boolean;
  readonly onDrawerOpenChange: (open: boolean) => void;
  readonly onOpenKeyboardMap: () => void;
}

function Header({
  mode,
  onToggle,
  toggleLabel,
}: {
  readonly mode: 'expanded' | 'rail' | 'drawer';
  readonly onToggle?: () => void;
  readonly toggleLabel?: string;
}) {
  const PanelLeft = ICONS.sidebar;
  const shortcut = formatCombo('mod+b', isMacLike());
  if (mode === 'rail') {
    return (
      <div className="flex h-(--topbar-height) shrink-0 items-center justify-center">
        <Hint side="right" label="Expand sidebar" shortcut={shortcut}>
          <button
            type="button"
            aria-label="Expand sidebar"
            onClick={onToggle}
            className="group/brand relative flex size-10 cursor-pointer items-center justify-center rounded-md hover:bg-sidebar-accent"
          >
            <BrandMark className="transition-opacity duration-(--duration-fast) group-hover/brand:opacity-0 group-focus-visible/brand:opacity-0" />
            <PanelLeft
              aria-hidden="true"
              className="absolute size-5 text-sidebar-accent-foreground opacity-0 transition-opacity duration-(--duration-fast) group-hover/brand:opacity-100 group-focus-visible/brand:opacity-100"
            />
          </button>
        </Hint>
      </div>
    );
  }
  return (
    <div className="flex h-(--topbar-height) shrink-0 items-center gap-2 pr-3 pl-4">
      <span className="flex min-w-0 flex-1 items-center gap-2.5">
        <BrandMark />
        <span className="truncate text-md font-semibold tracking-tight text-foreground">
          BrowserHive
        </span>
      </span>
      {mode === 'expanded' && onToggle !== undefined ? (
        <Hint side="right" label={toggleLabel ?? 'Collapse sidebar'} shortcut={shortcut}>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={toggleLabel ?? 'Collapse sidebar'}
            onClick={onToggle}
          >
            <PanelLeft aria-hidden="true" />
          </Button>
        </Hint>
      ) : null}
    </div>
  );
}

function Footer({
  collapsed,
  onOpenKeyboardMap,
}: {
  readonly collapsed: boolean;
  readonly onOpenKeyboardMap: () => void;
}) {
  const { version } = useNavSignals();
  const Keyboard = ICONS.keyboard;
  if (collapsed) {
    return (
      <div className="flex shrink-0 flex-col items-center gap-1 border-t border-sidebar-border py-3 pointer-coarse:hidden">
        <Hint side="right" label="Keyboard shortcuts" shortcut="?">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Keyboard shortcuts"
            onClick={onOpenKeyboardMap}
          >
            <Keyboard aria-hidden="true" className="size-5" />
          </Button>
        </Hint>
      </div>
    );
  }
  return (
    <div className="flex shrink-0 items-center justify-between gap-2 border-t border-sidebar-border px-3 py-3">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        // Keyboard shortcuts are noise on touch screens.
        className="text-muted-foreground pointer-coarse:hidden"
        onClick={onOpenKeyboardMap}
      >
        <Keyboard aria-hidden="true" />
        Shortcuts
        <Kbd className="ml-1">?</Kbd>
      </Button>
      {version !== null ? (
        <span className="ml-auto px-1 font-mono text-xs text-muted-foreground">v{version}</span>
      ) : null}
    </div>
  );
}

/** Sidebar. */
export function Sidebar({ band, drawerOpen, onDrawerOpenChange, onOpenKeyboardMap }: SidebarProps) {
  const [preference, setPreference] = useSidebarPreference();
  const drawer = band === 'sm';
  const rail = !drawer && preference === 'collapsed';
  const { peeking, onEnter, onLeave, close } = useHoverPeek(rail);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  useEffect(() => {
    // A navigation from inside the peek closes it; so does a route change from anywhere.
    if (pathname.length > 0) close();
  }, [pathname, close]);
  const toggle = () => setPreference(preference === 'collapsed' ? 'expanded' : 'collapsed');
  useShortcut({
    id: 'sidebar.toggle',
    combo: 'mod+b',
    description: 'Toggle sidebar',
    scope: 'global',
    group: 'General',
    handler: () => {
      if (drawer) onDrawerOpenChange(!drawerOpen);
      else toggle();
      return undefined;
    },
  });
  useShortcut(
    {
      id: 'sidebar.peek.close',
      combo: 'escape',
      description: 'Close the sidebar peek',
      scope: 'global',
      group: 'General',
      handler: () => {
        if (!peeking) return false;
        close();
        return undefined;
      },
    },
    peeking,
  );

  if (drawer) {
    return (
      <Sheet open={drawerOpen} onOpenChange={onDrawerOpenChange}>
        <SheetContent
          side="left"
          className="w-(--sidebar-width) max-w-[85vw] gap-0 bg-sidebar p-0"
          showCloseButton
        >
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <Header mode="drawer" />
          <SidebarNav collapsed={false} onNavigate={() => onDrawerOpenChange(false)} />
          <Footer
            collapsed={false}
            onOpenKeyboardMap={() => {
              onDrawerOpenChange(false);
              onOpenKeyboardMap();
            }}
          />
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <>
      <aside
        aria-label="Sidebar"
        data-state={rail ? 'collapsed' : 'expanded'}
        className={cn(
          'sticky top-0 flex h-dvh shrink-0 flex-col self-start border-r border-sidebar-border bg-sidebar',
          rail ? 'w-(--sidebar-width-icon)' : 'w-(--sidebar-width)',
        )}
      >
        <Header
          mode={rail ? 'rail' : 'expanded'}
          onToggle={toggle}
          toggleLabel="Collapse sidebar"
        />
        {rail ? (
          <div
            className="flex min-h-0 flex-1 flex-col"
            onPointerEnter={(event) => {
              if (event.pointerType === 'mouse') onEnter();
            }}
            onPointerLeave={(event) => {
              if (event.pointerType === 'mouse') onLeave();
            }}
          >
            <SidebarNav collapsed />
          </div>
        ) : (
          <SidebarNav collapsed={false} />
        )}
        <Footer collapsed={rail} onOpenKeyboardMap={onOpenKeyboardMap} />
      </aside>
      {rail && peeking ? (
        <div
          role="presentation"
          data-sidebar-peek=""
          className="fixed inset-y-0 left-0 z-(--z-rail) flex w-(--sidebar-width) animate-in flex-col border-r border-sidebar-border bg-sidebar shadow-lg duration-150 fade-in-0 slide-in-from-left-2"
          onPointerEnter={onEnter}
          onPointerLeave={onLeave}
        >
          <Header mode="expanded" onToggle={toggle} toggleLabel="Keep sidebar open" />
          <SidebarNav collapsed={false} onNavigate={close} />
          <Footer
            collapsed={false}
            onOpenKeyboardMap={() => {
              close();
              onOpenKeyboardMap();
            }}
          />
        </div>
      ) : null}
    </>
  );
}

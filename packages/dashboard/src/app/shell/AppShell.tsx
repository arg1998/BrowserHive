/** @module app/shell/AppShell — frame: sticky sidebar + sticky topbar with the document as the only scroller, or a fixed-height workspace when a page opts in; palette, keyboard map, toasts, global shortcuts, the daemon reachability watcher and its banner, and Install app */
import { type ReactNode, useState } from 'react';
import { useClientErrorSink } from '@/app/providers/AuthProvider.tsx';
import { useKeyboardScope, useShortcut } from '@/app/providers/KeyboardProvider.tsx';
import { useSocketState } from '@/app/providers/SocketProvider.tsx';
import { InstallAppProvider } from '@/features/install/install-app.tsx';
import { DaemonReachabilityProvider } from '@/lib/daemon-help/reachability.tsx';
import { cn } from '@/lib/utils.ts';
import { CommandPalette } from './CommandPalette.tsx';
import { DaemonUnreachableAnnouncer, ShellBanners } from './DaemonUnreachableBanner.tsx';
import { InstallToastBridge } from './InstallToastBridge.tsx';
import { KeyboardMap } from './KeyboardMap.tsx';
import { PageActionsProvider } from './page-actions.tsx';
import { WidgetBoundary } from './RouteError.tsx';
import { Sidebar } from './Sidebar.tsx';
import { ShellLayoutProvider, usePageLayout } from './shell-layout.tsx';
import { useShellBand } from './sidebar-state.ts';
import { ToastStack } from './ToastStack.tsx';
import { Topbar } from './Topbar.tsx';

/** Shell. */
export function AppShell({ children }: { readonly children: ReactNode }) {
  const socket = useSocketState();
  return (
    <DaemonReachabilityProvider socket={socket}>
      <InstallAppProvider>
        <ShellLayoutProvider>
          <PageActionsProvider>
            <Frame>{children}</Frame>
          </PageActionsProvider>
        </ShellLayoutProvider>
      </InstallAppProvider>
    </DaemonReachabilityProvider>
  );
}

function Frame({ children }: { readonly children: ReactNode }) {
  const band = useShellBand();
  const layout = usePageLayout();
  const sink = useClientErrorSink();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  useKeyboardScope('modal', paletteOpen || mapOpen);
  useShortcut({
    id: 'palette.open',
    combo: 'mod+k',
    description: 'Open the command palette',
    scope: 'global',
    group: 'General',
    allowInInput: true,
    handler: () => {
      setMapOpen(false);
      setPaletteOpen((o) => !o);
      return undefined;
    },
  });
  useShortcut({
    id: 'keymap.open',
    combo: '?',
    description: 'Show keyboard shortcuts',
    scope: 'global',
    group: 'General',
    handler: () => {
      setPaletteOpen(false);
      setMapOpen((o) => !o);
      return undefined;
    },
  });
  useShortcut({
    id: 'overlay.close',
    combo: 'escape',
    description: 'Close the topmost overlay',
    scope: 'global',
    group: 'General',
    allowInInput: true,
    handler: () => {
      if (paletteOpen) setPaletteOpen(false);
      else if (mapOpen) setMapOpen(false);
      else if (drawerOpen) setDrawerOpen(false);
      else return false;
      return undefined;
    },
  });
  const report = (error: Error) =>
    sink.report({
      message: error.message,
      ...(error.stack !== undefined && { stack: error.stack }),
      route: window.location.pathname,
    });
  const workspace = layout === 'workspace';
  return (
    <div className={cn('flex min-h-dvh bg-background', workspace && 'h-dvh overflow-hidden')}>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-(--z-tooltip) focus:rounded-md focus:bg-popover focus:px-3 focus:py-2 focus:shadow-popover"
      >
        Skip to content
      </a>
      <WidgetBoundary onError={report}>
        <Sidebar
          band={band}
          drawerOpen={drawerOpen}
          onDrawerOpenChange={setDrawerOpen}
          onOpenKeyboardMap={() => setMapOpen(true)}
        />
      </WidgetBoundary>
      <div className="flex min-w-0 flex-1 flex-col">
        <WidgetBoundary
          onError={report}
          fallback={<div className="h-(--topbar-height) shrink-0 border-b" />}
        >
          <Topbar
            band={band}
            onOpenDrawer={() => setDrawerOpen(true)}
            onOpenPalette={() => setPaletteOpen(true)}
            onOpenKeyboardMap={() => setMapOpen(true)}
          />
        </WidgetBoundary>
        <ShellBanners />
        <main
          id="main"
          tabIndex={-1}
          data-layout={layout}
          className={cn(
            'relative flex min-w-0 flex-col px-gutter pt-6 outline-none',
            // Same top padding in both layouts so the page title never hops.
            workspace
              ? 'min-h-0 flex-1 overflow-hidden pb-4 [--table-sticky-top:0px]'
              : 'flex-1 pb-12',
          )}
        >
          {children}
        </main>
      </div>
      <WidgetBoundary onError={report}>
        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
        <KeyboardMap open={mapOpen} onOpenChange={setMapOpen} />
      </WidgetBoundary>
      <ToastStack />
      <DaemonUnreachableAnnouncer />
      <InstallToastBridge />
    </div>
  );
}

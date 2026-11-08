/** @module features/install/install-app — the one **Install app** handler (04 §18.8.4), shared by the account menu and the command palette: the browser's own install dialog when it offered one, otherwise `InstallAppDialog` for this browser. Mounted once by `AppShell`. */
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import { InstallPromptStore, type PromptSnapshot } from '@/lib/install/prompt-store.ts';
import {
  type ChromiumBrand,
  type InstallInput,
  installSupport,
  readInstallInput,
} from '@/lib/install/support.ts';
import { type DialogKind, type DialogLocation, InstallAppDialog } from './InstallAppDialog.tsx';

/** What the shell's entry points need. */
export interface InstallApp {
  /** `false` inside the installed app (the item and the palette action are hidden). */
  readonly visible: boolean;
  /** Run Install app: the browser's prompt, or our dialog. */
  readonly run: () => void;
  /** The offer store (the toast bridge watches its `installed` signal). */
  readonly store: InstallPromptStore;
}

const InstallAppContext = createContext<InstallApp | null>(null);

/** Props; everything the browser provides is injectable for tests. */
export interface InstallAppProviderProps {
  readonly children: ReactNode;
  readonly store?: InstallPromptStore;
  /** Reads the environment; called at mount (visibility) and on every run (the offer may have arrived). */
  readonly readInput?: (hasPrompt: boolean) => InstallInput;
  readonly location?: DialogLocation;
}

const browserInput = (hasPrompt: boolean): InstallInput => readInstallInput(window, hasPrompt);

/** Owns the offer store and the dialog. */
export function InstallAppProvider({
  children,
  store: injected,
  readInput = browserInput,
  location,
}: InstallAppProviderProps) {
  const [store] = useState(() => injected ?? new InstallPromptStore(window));
  const [standalone] = useState(() => readInput(false).standalone);
  const [dialog, setDialog] = useState<{ kind: DialogKind; brand: ChromiumBrand | null } | null>(
    null,
  );
  useEffect(() => {
    store.start();
    return () => store.stop();
  }, [store]);
  const run = useCallback(() => {
    const support = installSupport(readInput(store.hasPrompt()));
    if (support.kind === 'standalone') return;
    if (support.kind === 'prompt') {
      // Called inside the click, so the browser sees the user's gesture.
      void store.prompt();
      return;
    }
    setDialog({ kind: support.kind, brand: support.brand });
  }, [store, readInput]);
  const value = useMemo<InstallApp>(
    () => ({ visible: !standalone, run, store }),
    [standalone, run, store],
  );
  return (
    <InstallAppContext.Provider value={value}>
      {children}
      <InstallAppDialog
        kind={dialog?.kind ?? null}
        brand={dialog?.brand ?? null}
        location={location ?? window.location}
        onClose={() => setDialog(null)}
      />
    </InstallAppContext.Provider>
  );
}

/** The handler, or `null` outside the shell (the entry points then render nothing). */
export function useInstallApp(): InstallApp | null {
  return useContext(InstallAppContext);
}

const NOTHING: PromptSnapshot = { available: false, installed: 0 };
const noSubscribe = () => () => undefined;

/** The offer store's snapshot (an unchanging empty one outside the shell). */
export function useInstallPrompt(): PromptSnapshot {
  const store = useInstallApp()?.store;
  return useSyncExternalStore(
    store?.subscribe ?? noSubscribe,
    store?.getSnapshot ?? (() => NOTHING),
  );
}

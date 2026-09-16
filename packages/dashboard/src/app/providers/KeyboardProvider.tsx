/** @module app/providers/KeyboardProvider — one keyboard registry + window listener; `useShortcut()`, `useKeyboardScope()` (spec 04 §6.5) */
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { KeyboardRegistry, type Shortcut, type ShortcutScope } from '@/lib/keyboard.ts';

const KeyboardContext = createContext<KeyboardRegistry | null>(null);

/** Owns the registry and the single `keydown` listener. */
export function KeyboardProvider({ children }: { readonly children: ReactNode }) {
  const [registry] = useState(() => new KeyboardRegistry());
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      registry.handle(event);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [registry]);
  return <KeyboardContext.Provider value={registry}>{children}</KeyboardContext.Provider>;
}

/** The registry. */
export function useKeyboard(): KeyboardRegistry {
  const value = useContext(KeyboardContext);
  if (value === null) throw new Error('useKeyboard() requires KeyboardProvider');
  return value;
}

/** Register a shortcut while mounted. The handler is read through a ref so it may close over fresh state. */
export function useShortcut(
  shortcut: Omit<Shortcut, 'handler'> & { readonly handler: Shortcut['handler'] },
  enabled = true,
): void {
  const registry = useKeyboard();
  const handlerRef = useRef(shortcut.handler);
  handlerRef.current = shortcut.handler;
  const { id, combo, description, scope, group, allowInInput } = shortcut;
  useEffect(() => {
    if (!enabled) return undefined;
    return registry.register({
      id,
      combo,
      description,
      scope,
      ...(group !== undefined && { group }),
      ...(allowInInput !== undefined && { allowInInput }),
      handler: (event) => handlerRef.current(event),
    });
  }, [registry, id, combo, description, scope, group, allowInInput, enabled]);
}

/** Activate a scope while `active` (modal open, table focused, capture on). */
export function useKeyboardScope(scope: ShortcutScope, active: boolean): void {
  const registry = useKeyboard();
  useEffect(() => (active ? registry.activate(scope) : undefined), [registry, scope, active]);
}

/** Live list of shortcuts (for the `?` overlay). */
export function useShortcutList(): readonly Shortcut[] {
  const registry = useKeyboard();
  const snapshotRef = useRef<readonly Shortcut[]>([]);
  return useSyncExternalStore(
    (cb) => registry.onChange(cb),
    () => {
      const next = registry.list();
      const prev = snapshotRef.current;
      if (prev.length === next.length && prev.every((s, i) => s === next[i])) return prev;
      snapshotRef.current = next;
      return next;
    },
    () => snapshotRef.current,
  );
}

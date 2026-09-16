/** @module lib/keyboard — scoped shortcut registry: one window listener, components register on mount (spec 04 §6.5) */

/** Scopes, from outermost to innermost. `capture` (live-view takeover) swallows everything but Esc. */
export type ShortcutScope = 'global' | 'page' | 'table' | 'modal' | 'capture';

/** A registered shortcut. `combo` uses `mod` for ⌘/Ctrl: `mod+k`, `shift+/`, `escape`, `j`. */
export interface Shortcut {
  readonly id: string;
  readonly combo: string;
  readonly description: string;
  readonly scope: ShortcutScope;
  /** Group label for the `?` overlay. */
  readonly group?: string;
  /** Fire even when focus is in a text input (default: skipped). */
  readonly allowInInput?: boolean;
  /** Return `false` to let the event continue (default: prevented + stopped). */
  readonly handler: (event: KeyboardEvent) => boolean | undefined;
}

/** Parsed combo. */
interface Combo {
  readonly key: string;
  readonly mod: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
}

/** Keys whose display differs from `event.key`. */
const KEY_ALIASES: Readonly<Record<string, string>> = {
  esc: 'escape',
  space: ' ',
  plus: '+',
  minus: '-',
  question: '?',
  slash: '/',
};

/** Parse `mod+shift+k` into its parts. */
export function parseCombo(combo: string): Combo {
  const parts = combo.toLowerCase().split('+');
  const key = parts[parts.length - 1] ?? '';
  return {
    key: KEY_ALIASES[key] ?? key,
    mod: parts.includes('mod'),
    shift: parts.includes('shift'),
    alt: parts.includes('alt'),
  };
}

/**
 * Keys produced by Shift + another key on a US layout. A combo written either way (`?` or
 * `shift+/`) matches the event the browser actually sends (`key: "?"`, `shiftKey: true`).
 */
const SHIFTED: Readonly<Record<string, string>> = {
  '/': '?',
  '1': '!',
  '2': '@',
  '3': '#',
  '4': '$',
  '5': '%',
  '6': '^',
  '7': '&',
  '8': '*',
  '9': '(',
  '0': ')',
  '-': '_',
  '=': '+',
  ',': '<',
  '.': '>',
  ';': ':',
  "'": '"',
  '[': '{',
  ']': '}',
  '\\': '|',
  '`': '~',
};

/** Does a keyboard event match a combo? `mod` = ⌘ on macOS-like platforms, Ctrl elsewhere (both accepted). */
export function matchesCombo(event: KeyboardEvent, combo: string): boolean {
  const parsed = parseCombo(combo);
  const key = event.key.toLowerCase();
  const mod = event.metaKey || event.ctrlKey;
  if (parsed.mod !== mod) return false;
  if (parsed.alt !== event.altKey) return false;
  // `shift+/` written for `?`: compare against the shifted character the browser reports.
  const shiftedTarget = parsed.shift ? SHIFTED[parsed.key] : undefined;
  if (shiftedTarget !== undefined) return event.key === shiftedTarget;
  if (parsed.key !== key) return false;
  // Letters and digits must match Shift exactly (`j` ≠ `J`); punctuation already encodes it.
  if (/^[a-z0-9]$/.test(parsed.key) && parsed.shift !== event.shiftKey) return false;
  return true;
}

/** Is the event target something the operator types into? */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (target.getAttribute('type') ?? 'text').toLowerCase();
    return !['checkbox', 'radio', 'button', 'submit', 'range', 'file'].includes(type);
  }
  return target.getAttribute('role') === 'textbox';
}

/** The registry. One per app instance (`KeyboardProvider`), never a module singleton. */
export class KeyboardRegistry {
  private readonly shortcuts = new Map<string, Shortcut>();
  private readonly active: ShortcutScope[] = [];
  private readonly listeners = new Set<() => void>();

  /** Register a shortcut; returns the unregister function. Later registrations shadow earlier ids. */
  register(shortcut: Shortcut): () => void {
    this.shortcuts.set(shortcut.id, shortcut);
    this.emit();
    return () => {
      if (this.shortcuts.get(shortcut.id) === shortcut) {
        this.shortcuts.delete(shortcut.id);
        this.emit();
      }
    };
  }

  /** Activate a scope (push); returns the deactivation function (pop). */
  activate(scope: ShortcutScope): () => void {
    this.active.push(scope);
    this.emit();
    return () => {
      const index = this.active.lastIndexOf(scope);
      if (index >= 0) this.active.splice(index, 1);
      this.emit();
    };
  }

  /** Scopes currently active (in activation order). */
  activeScopes(): readonly ShortcutScope[] {
    return [...this.active];
  }

  /** Every registered shortcut (for the `?` overlay). */
  list(): readonly Shortcut[] {
    return [...this.shortcuts.values()];
  }

  /** Subscribe to registry changes (for `useSyncExternalStore`). */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Dispatch a keydown; returns `true` when a shortcut handled it. */
  handle(event: KeyboardEvent): boolean {
    if (event.defaultPrevented) return false;
    const captureActive = this.active.includes('capture');
    const modalActive = this.active.includes('modal');
    const editable = isEditableTarget(event.target);
    for (const shortcut of [...this.shortcuts.values()].reverse()) {
      if (!this.scopeEnabled(shortcut.scope, captureActive, modalActive)) continue;
      if (editable && shortcut.allowInInput !== true) continue;
      if (!matchesCombo(event, shortcut.combo)) continue;
      const result = shortcut.handler(event);
      if (result === false) continue;
      event.preventDefault();
      event.stopPropagation();
      return true;
    }
    return false;
  }

  private scopeEnabled(scope: ShortcutScope, capture: boolean, modal: boolean): boolean {
    if (capture) return scope === 'capture';
    switch (scope) {
      case 'global':
        return true;
      case 'modal':
        return modal;
      case 'page':
        return !modal;
      case 'table':
        return !modal && this.active.includes('table');
      case 'capture':
        return false;
      default:
        return assertNever(scope);
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

/** Human-readable key label for the overlay: `⌘K` on macOS-like, `Ctrl+K` elsewhere. */
export function formatCombo(combo: string, isMac: boolean): string {
  const parts = combo.split('+').map((p) => p.toLowerCase());
  const key = parts[parts.length - 1] ?? '';
  const named: Readonly<Record<string, string>> = {
    escape: 'Esc',
    enter: 'Enter',
    arrowup: '↑',
    arrowdown: '↓',
    arrowleft: '←',
    arrowright: '→',
    space: 'Space',
    ' ': 'Space',
    home: 'Home',
    end: 'End',
    f10: 'F10',
    contextmenu: 'Menu',
  };
  const shifted = parts.includes('shift') ? SHIFTED[key] : undefined;
  if (shifted !== undefined) return shifted;
  const keyLabel = named[key] ?? (key.length === 1 ? key.toUpperCase() : key);
  const mods: string[] = [];
  if (parts.includes('mod')) mods.push(isMac ? '⌘' : 'Ctrl');
  if (parts.includes('shift')) mods.push(isMac ? '⇧' : 'Shift');
  if (parts.includes('alt')) mods.push(isMac ? '⌥' : 'Alt');
  return isMac ? `${mods.join('')}${keyLabel}` : [...mods, keyLabel].join('+');
}

function assertNever(value: never): never {
  throw new Error(`unhandled scope ${String(value)}`);
}

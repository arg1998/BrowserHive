/** @module features/site-packs/decision-focus — where keyboard focus goes after an action on a decision card (spec 13 §11.4 "focus returns to the card after an action"; review #100 M5): a card that stays (Download & review) focuses its own heading; a card that leaves (Apply, Reject, Pin) hands focus to the next card's heading, else the Updates heading, else the pack's row (or the page's fallback); a failed action leaves focus on its button. The scope outlives the Updates section, which unmounts with its last card */
import { createContext, type ReactNode, useContext, useEffect, useRef } from 'react';

/** What a card tells the scope. */
export interface DecisionFocus {
  /** An action that may remove the card started (after any confirmation). */
  readonly start: (key: string) => void;
  /** The action failed or the card stays: forget it. */
  readonly cancel: (key: string) => void;
}

const Ctx = createContext<DecisionFocus | null>(null);

/** The scope's handle, or `null` outside one. */
export function useDecisionFocus(): DecisionFocus | null {
  return useContext(Ctx);
}

/** Focus an element, making it programmatically focusable first when it is not. */
export function focusElement(el: HTMLElement | null | undefined): boolean {
  if (el === null || el === undefined) return false;
  if (el.tabIndex < 0 && !el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
  el.focus();
  return document.activeElement === el;
}

/** The pack id of a decision key (`<pack id>@<version|local|revoked>`). */
export function packOfKey(key: string): string {
  const at = key.lastIndexOf('@');
  return at < 0 ? key : key.slice(0, at);
}

/**
 * The scope: give it the decisions' keys in display order; `fallback` receives the pack id when no
 * card is left to focus.
 */
export function DecisionFocusScope({
  keys,
  fallback,
  children,
}: {
  readonly keys: readonly string[];
  readonly fallback: (packId: string) => void;
  readonly children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const started = useRef(new Map<string, number>());
  const order = useRef(keys);
  order.current = keys;
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;
  const handle = useRef<DecisionFocus>({
    start: (key) => {
      started.current.set(key, Math.max(0, order.current.indexOf(key)));
    },
    cancel: (key) => {
      started.current.delete(key);
    },
  });
  const joined = keys.join('\n');
  useEffect(() => {
    const present = new Set(joined === '' ? [] : joined.split('\n'));
    for (const [key, index] of started.current) {
      if (present.has(key)) continue;
      started.current.delete(key);
      const scope = root.current;
      const cards = Array.from(scope?.querySelectorAll<HTMLElement>('[data-decision]') ?? []);
      const next = cards[Math.min(index, cards.length - 1)];
      if (focusElement(next?.querySelector<HTMLElement>('[data-card-heading]'))) continue;
      if (focusElement(scope?.querySelector<HTMLElement>('[data-updates] h2'))) continue;
      fallbackRef.current(packOfKey(key));
    }
  }, [joined]);
  return (
    <Ctx.Provider value={handle.current}>
      <div ref={root} className="contents">
        {children}
      </div>
    </Ctx.Provider>
  );
}

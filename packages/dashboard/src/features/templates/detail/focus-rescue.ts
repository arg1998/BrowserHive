/** @module features/templates/detail/focus-rescue — keeps keyboard focus on the template page when a control the operator used goes away (review #81 L-15): the agents-paused banner after **Let agents continue**, a re-login panel after **Cancel re-login** or **I'm signed in**; focus moves to the site's card heading (or the selected tab) instead of falling to `<body>` */
import { type RefObject, useEffect, useRef } from 'react';

/** Focus fallbacks re-check this long after the node goes (a closing confirmation returns focus late). */
const SETTLE_MS = [0, 400] as const;

/** The heading of a site's card on the Sites tab (focusable with `tabIndex={-1}`), or `null`. */
export function siteCardHeading(siteId: string | null): HTMLElement | null {
  if (siteId === null) return null;
  for (const card of document.querySelectorAll<HTMLElement>('[data-site]')) {
    if (card.dataset['site'] === siteId) return card.querySelector<HTMLElement>('h2');
  }
  return null;
}

/** The selected tab of the template page. */
export function selectedTemplateTab(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '[aria-label="Template sections"] [role="tab"][aria-selected="true"]',
  );
}

function focusLost(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || !active.isConnected;
}

/**
 * While `ref`'s element is shown, remembers whether the operator is working in it (focus inside it,
 * or in a dialog it opened). When it goes (`key` changes or the component unmounts) and focus fell
 * to `<body>`, focus moves to `target()`.
 */
export function useFocusRescue(
  ref: RefObject<HTMLElement | null>,
  target: () => HTMLElement | null,
  key: unknown,
): void {
  const targetRef = useRef(target);
  useEffect(() => {
    targetRef.current = target;
  });
  useEffect(() => {
    const node = ref.current;
    if (node === null || key === null) return undefined;
    let engaged = node.contains(document.activeElement);
    const onIn = () => {
      engaged = true;
    };
    const onOut = (event: FocusEvent) => {
      const next = event.relatedTarget;
      if (
        next instanceof Element &&
        !node.contains(next) &&
        next.closest('[role="dialog"],[role="alertdialog"]') === null
      )
        engaged = false;
    };
    node.addEventListener('focusin', onIn);
    node.addEventListener('focusout', onOut);
    return () => {
      node.removeEventListener('focusin', onIn);
      node.removeEventListener('focusout', onOut);
      if (!engaged) return;
      for (const ms of SETTLE_MS) {
        setTimeout(() => {
          if (focusLost()) targetRef.current()?.focus();
        }, ms);
      }
    };
  }, [ref, key]);
}

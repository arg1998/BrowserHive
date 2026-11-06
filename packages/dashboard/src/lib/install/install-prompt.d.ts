/** @module lib/install/install-prompt — DOM types Chromium has and TypeScript's lib does not: the `beforeinstallprompt` event, `appinstalled`, and the event the inline bootstrap in `index.html` keeps on `window` (04 §18.2, §18.8.1). */

/** Chromium's install offer (`beforeinstallprompt`). */
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: readonly string[];
  readonly userChoice: Promise<{
    readonly outcome: 'accepted' | 'dismissed';
    readonly platform: string;
  }>;
  /** Shows the browser's install dialog; usable once per event. */
  prompt(): Promise<unknown>;
}

interface WindowEventMap {
  beforeinstallprompt: BeforeInstallPromptEvent;
  appinstalled: Event;
}

interface Window {
  /**
   * Set by the inline bootstrap in `index.html` (`preventDefault()` already called) when the offer
   * arrives before the bundle runs; the prompt store adopts it and clears it.
   */
  __bhInstallPrompt?: BeforeInstallPromptEvent | undefined;
}

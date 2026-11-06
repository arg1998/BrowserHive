/** @module lib/install/prompt-store — holds the browser's install offer (04 §18.8.1): adopts the event the inline bootstrap captured, catches later ones (`preventDefault()` stops mobile Chromium's mini-infobar), prompts at most once per event, and signals `appinstalled`. Read with `useSyncExternalStore`. */

/** The part of `window` the store uses (tests pass a fake). */
export interface PromptTarget {
  __bhInstallPrompt?: BeforeInstallPromptEvent | undefined;
  addEventListener(
    type: 'beforeinstallprompt',
    listener: (event: BeforeInstallPromptEvent) => void,
  ): void;
  addEventListener(type: 'appinstalled', listener: (event: Event) => void): void;
  removeEventListener(
    type: 'beforeinstallprompt',
    listener: (event: BeforeInstallPromptEvent) => void,
  ): void;
  removeEventListener(type: 'appinstalled', listener: (event: Event) => void): void;
}

/** What `prompt()` led to. */
export type PromptResult = 'accepted' | 'dismissed' | 'unavailable';

/** The store's state; a new object only when it changes. */
export interface PromptSnapshot {
  /** An unused install offer is held. */
  readonly available: boolean;
  /** Counts `appinstalled` events (a signal: subscribers compare it with the last value seen). */
  readonly installed: number;
}

/** The install offer store. `start()` attaches it to the window, `stop()` detaches it. */
export class InstallPromptStore {
  private event: BeforeInstallPromptEvent | null = null;
  private snapshot: PromptSnapshot = { available: false, installed: 0 };
  private readonly listeners = new Set<() => void>();
  private started = false;

  constructor(private readonly target: PromptTarget) {}

  /** The current snapshot (stable between changes). */
  readonly getSnapshot = (): PromptSnapshot => this.snapshot;

  /** Observe changes. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Adopt the bootstrap's event and listen for later ones (idempotent). */
  start(): void {
    if (this.started) return;
    this.started = true;
    const early = this.target.__bhInstallPrompt;
    // Taken, not shared: a later mount must not adopt an event this store already used.
    this.target.__bhInstallPrompt = undefined;
    if (early !== undefined) this.hold(early);
    this.target.addEventListener('beforeinstallprompt', this.onOffer);
    this.target.addEventListener('appinstalled', this.onInstalled);
  }

  /** Stop listening. The held event is kept on the window for the next `start()`. */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.target.removeEventListener('beforeinstallprompt', this.onOffer);
    this.target.removeEventListener('appinstalled', this.onInstalled);
    if (this.event !== null) this.target.__bhInstallPrompt = this.event;
    this.event = null;
    this.set({ available: false });
  }

  /** `true` while an unused offer is held. */
  hasPrompt(): boolean {
    return this.event !== null;
  }

  /**
   * Shows the browser's install dialog. The event is dropped whatever the outcome (Chromium may
   * offer a new one later); without one this resolves `unavailable` and shows nothing.
   */
  async prompt(): Promise<PromptResult> {
    const event = this.event;
    if (event === null) return 'unavailable';
    this.event = null;
    this.set({ available: false });
    try {
      await event.prompt();
      const choice = await event.userChoice;
      return choice.outcome;
    } catch {
      return 'unavailable';
    }
  }

  private readonly onOffer = (event: BeforeInstallPromptEvent): void => {
    event.preventDefault();
    // The bootstrap's own listener also stored it; this store owns it from now on.
    if (this.target.__bhInstallPrompt === event) this.target.__bhInstallPrompt = undefined;
    this.hold(event);
  };

  private readonly onInstalled = (): void => {
    this.event = null;
    this.set({ available: false, installed: this.snapshot.installed + 1 });
  };

  private hold(event: BeforeInstallPromptEvent): void {
    this.event = event;
    this.set({ available: true });
  }

  private set(patch: Partial<PromptSnapshot>): void {
    const next = { ...this.snapshot, ...patch };
    if (next.available === this.snapshot.available && next.installed === this.snapshot.installed)
      return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

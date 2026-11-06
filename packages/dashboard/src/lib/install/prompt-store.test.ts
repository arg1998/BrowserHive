/** @module lib/install/prompt-store.test — adopts the bootstrap's `window.__bhInstallPrompt`, catches later offers with `preventDefault()`, prompts once per event, and `appinstalled` clears the event and signals `installed` (04 §18.8.1) */
import { describe, expect, it } from 'bun:test';
import { InstallPromptStore, type PromptTarget } from './prompt-store.ts';

/** A fake `beforeinstallprompt` event that records its use. */
function offer(outcome: 'accepted' | 'dismissed' = 'dismissed') {
  const calls = { prompt: 0, preventDefault: 0 };
  const event = Object.assign(new Event('beforeinstallprompt'), {
    platforms: ['web'],
    userChoice: Promise.resolve({ outcome, platform: 'web' }),
    prompt: async () => {
      calls.prompt += 1;
    },
  });
  event.preventDefault = () => {
    calls.preventDefault += 1;
  };
  return { event: event as BeforeInstallPromptEvent, calls };
}

/** A fake window: an EventTarget with the bootstrap's slot. */
function fakeWindow(early?: BeforeInstallPromptEvent) {
  const target = new EventTarget() as EventTarget & PromptTarget;
  target.__bhInstallPrompt = early;
  return target;
}

describe('InstallPromptStore', () => {
  it('adopts the event the inline bootstrap captured, and takes it off the window', () => {
    const { event } = offer();
    const win = fakeWindow(event);
    const store = new InstallPromptStore(win);
    expect(store.hasPrompt()).toBe(false);
    store.start();
    expect(store.hasPrompt()).toBe(true);
    expect(store.getSnapshot().available).toBe(true);
    expect(win.__bhInstallPrompt).toBeUndefined();
  });

  it('catches later offers and calls preventDefault()', () => {
    const win = fakeWindow();
    const store = new InstallPromptStore(win);
    let changes = 0;
    store.subscribe(() => {
      changes += 1;
    });
    store.start();
    expect(store.hasPrompt()).toBe(false);
    const { event, calls } = offer();
    // The bootstrap's own listener (registered first) stored it too.
    win.__bhInstallPrompt = event;
    win.dispatchEvent(event);
    expect(calls.preventDefault).toBe(1);
    expect(store.hasPrompt()).toBe(true);
    expect(win.__bhInstallPrompt).toBeUndefined();
    expect(changes).toBe(1);
  });

  it('prompts once: the event is dropped whatever the outcome', async () => {
    const { event, calls } = offer('dismissed');
    const store = new InstallPromptStore(fakeWindow(event));
    store.start();
    expect(await store.prompt()).toBe('dismissed');
    expect(calls.prompt).toBe(1);
    expect(store.hasPrompt()).toBe(false);
    expect(await store.prompt()).toBe('unavailable');
    expect(calls.prompt).toBe(1);
  });

  it('calls prompt() synchronously, inside the click that asked for it', () => {
    const { event, calls } = offer('accepted');
    const store = new InstallPromptStore(fakeWindow(event));
    store.start();
    void store.prompt();
    expect(calls.prompt).toBe(1);
  });

  it('appinstalled clears the event and emits installed', () => {
    const { event } = offer();
    const win = fakeWindow(event);
    const store = new InstallPromptStore(win);
    store.start();
    win.dispatchEvent(new Event('appinstalled'));
    expect(store.hasPrompt()).toBe(false);
    expect(store.getSnapshot()).toEqual({ available: false, installed: 1 });
    win.dispatchEvent(new Event('appinstalled'));
    expect(store.getSnapshot().installed).toBe(2);
  });

  it('stop() detaches and leaves an unused event for the next start()', () => {
    const { event } = offer();
    const win = fakeWindow(event);
    const first = new InstallPromptStore(win);
    first.start();
    first.stop();
    expect(win.__bhInstallPrompt).toBe(event);
    const later = offer();
    win.dispatchEvent(later.event);
    expect(later.calls.preventDefault).toBe(0);
    const second = new InstallPromptStore(win);
    second.start();
    expect(second.hasPrompt()).toBe(true);
  });
});

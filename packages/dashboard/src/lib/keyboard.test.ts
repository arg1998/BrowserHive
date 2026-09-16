/** @module lib/keyboard.test — scope registry: inputs skipped, capture swallows, modal gates page scope */
import '../../test/setup.ts';
import { describe, expect, it } from 'bun:test';
import { formatCombo, isEditableTarget, KeyboardRegistry, matchesCombo } from './keyboard.ts';

function key(init: KeyboardEventInit & { target?: EventTarget }): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  if (init.target !== undefined) Object.defineProperty(event, 'target', { value: init.target });
  return event;
}

describe('keyboard registry', () => {
  it('matches mod combos on either modifier and formats per platform', () => {
    expect(matchesCombo(key({ key: 'k', metaKey: true }), 'mod+k')).toBe(true);
    expect(matchesCombo(key({ key: 'k', ctrlKey: true }), 'mod+k')).toBe(true);
    expect(matchesCombo(key({ key: 'k' }), 'mod+k')).toBe(false);
    expect(formatCombo('mod+k', true)).toBe('⌘K');
    expect(formatCombo('mod+k', false)).toBe('Ctrl+K');
  });

  it('matches ? whether the combo is written `?` or `shift+/`', () => {
    // What the browser sends for Shift + / on a US layout.
    const question = key({ key: '?', shiftKey: true });
    expect(matchesCombo(question, 'shift+/')).toBe(true);
    expect(matchesCombo(question, '?')).toBe(true);
    expect(matchesCombo(key({ key: '/' }), 'shift+/')).toBe(false);
    expect(matchesCombo(key({ key: '/' }), '/')).toBe(true);
    expect(matchesCombo(key({ key: '?', shiftKey: true, ctrlKey: true }), '?')).toBe(false);
    expect(formatCombo('shift+/', false)).toBe('?');
    expect(formatCombo('arrowdown', false)).toBe('↓');
  });

  it('keeps Shift strict for letters so j and J differ', () => {
    expect(matchesCombo(key({ key: 'j' }), 'j')).toBe(true);
    expect(matchesCombo(key({ key: 'J', shiftKey: true }), 'j')).toBe(false);
    expect(matchesCombo(key({ key: 'J', shiftKey: true }), 'shift+j')).toBe(true);
  });

  it('opens the keyboard map from a real ? keypress through the registry', () => {
    const registry = new KeyboardRegistry();
    let opened = 0;
    registry.register({
      id: 'keymap.open',
      combo: '?',
      description: 'Keyboard shortcuts',
      scope: 'global',
      handler: () => {
        opened += 1;
        return undefined;
      },
    });
    expect(registry.handle(key({ key: '?', shiftKey: true }))).toBe(true);
    expect(opened).toBe(1);
  });

  it('skips inputs unless allowed and honours scopes', () => {
    const registry = new KeyboardRegistry();
    const fired: string[] = [];
    registry.register({
      id: 'g',
      combo: 'mod+k',
      description: 'palette',
      scope: 'global',
      allowInInput: true,
      handler: () => void fired.push('g'),
    });
    registry.register({
      id: 'p',
      combo: '/',
      description: 'filter',
      scope: 'page',
      handler: () => void fired.push('p'),
    });
    registry.register({
      id: 'c',
      combo: 'escape',
      description: 'release',
      scope: 'capture',
      handler: () => void fired.push('c'),
    });
    const input = document.createElement('input');
    expect(isEditableTarget(input)).toBe(true);
    expect(registry.handle(key({ key: '/', target: input }))).toBe(false);
    expect(registry.handle(key({ key: 'k', ctrlKey: true, target: input }))).toBe(true);
    expect(registry.handle(key({ key: '/' }))).toBe(true);
    const leaveModal = registry.activate('modal');
    expect(registry.handle(key({ key: '/' }))).toBe(false);
    leaveModal();
    const leaveCapture = registry.activate('capture');
    expect(registry.handle(key({ key: 'k', ctrlKey: true }))).toBe(false);
    expect(registry.handle(key({ key: 'Escape' }))).toBe(true);
    leaveCapture();
    expect(fired).toEqual(['g', 'p', 'c']);
  });

  it('lets a handler decline by returning false', () => {
    const registry = new KeyboardRegistry();
    registry.register({
      id: 'a',
      combo: 'escape',
      description: 'a',
      scope: 'global',
      handler: () => false,
    });
    expect(registry.handle(key({ key: 'Escape' }))).toBe(false);
  });
});

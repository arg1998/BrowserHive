/** @module domain/templates/clipboard-chords.test — the clipboard chords refused in template sessions (spec 13 §3.3). */
import { describe, expect, it } from 'bun:test';
import { isClipboardChord } from './clipboard-chords.ts';

describe('isClipboardChord', () => {
  it('refuses paste, copy and cut in any modifier order, ControlOrMeta included', () => {
    for (const key of [
      'Control+V',
      'Meta+V',
      'Shift+Insert',
      'Control+C',
      'Meta+C',
      'Control+Insert',
      'Control+X',
      'Meta+X',
      'ControlOrMeta+v',
      'Shift+Control+V',
      'Control+Shift+v',
      'Alt+Meta+x',
      'Control+KeyV',
      ' control + c ',
    ]) {
      expect([key, isClipboardChord(key)]).toEqual([key, true]);
    }
  });

  it('lets every other key and chord through', () => {
    for (const key of [
      'v',
      'V',
      'Insert',
      'Enter',
      'Control+A',
      'Shift+V',
      'Alt+V',
      'Control+Z',
      'Control++',
      '+',
      'Meta+Shift+T',
    ]) {
      expect([key, isClipboardChord(key)]).toEqual([key, false]);
    }
  });
});

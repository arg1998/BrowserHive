/** @module domain/templates/clipboard-chords — the keyboard shortcuts `press_key` refuses in template sessions (spec 13 §3.3): CDP key events count as user input, so on a headed template a paste would read the operator's clipboard and a copy would overwrite it. */

import { TEMPLATE_CLIPBOARD_TEXT } from '@browserhive/contracts/tools';

/** The refusal text (`INVALID_ARGUMENTS`), agent-facing (spec 13 §5; pinned by the wording golden). */
export const CLIPBOARD_CHORD_MESSAGE = TEMPLATE_CLIPBOARD_TEXT;

/** Modifiers that make V, C or X a clipboard shortcut (`ControlOrMeta` is Playwright's alias). */
const PRIMARY = new Set(['control', 'meta', 'controlormeta', 'ctrl', 'cmd', 'command']);

/**
 * True when `key` (Playwright's `press` syntax: `Modifier+…+Key`, any order) is a clipboard chord:
 * Control, Meta or ControlOrMeta with V, C or X, with or without other modifiers; Shift+Insert;
 * Control+Insert.
 */
export function isClipboardChord(key: string): boolean {
  // `+` itself can be the key (`Control++`): split on `+` that joins two names.
  const parts = key
    .split(/\+(?=.)/)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part !== '');
  if (parts.length < 2) return false;
  const main = parts[parts.length - 1] ?? '';
  const modifiers = new Set(parts.slice(0, -1));
  const primary = [...modifiers].some((m) => PRIMARY.has(m));
  if (primary && ['v', 'c', 'x', 'keyv', 'keyc', 'keyx'].includes(main)) return true;
  if (main === 'insert') return modifiers.has('shift') || primary;
  return false;
}

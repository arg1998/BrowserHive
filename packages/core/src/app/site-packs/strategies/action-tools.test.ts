/** @module app/site-packs/strategies/action-tools.test — the before-action tool table (spec 13 §9.6): every tool is classified; navigations, interactions and the focus-only tools are the documented ones. */

import { describe, expect, it } from 'bun:test';
import { ALL_TOOL_NAMES } from '@browserhive/contracts/tools';
import { ACTION_TOOLS, actionKindOf } from './action-tools.ts';

const byKind = (kind: string | null) =>
  ALL_TOOL_NAMES.filter((name) => ACTION_TOOLS[name] === kind).sort();

describe('action tools', () => {
  it('classifies every tool of the registry', () => {
    expect(Object.keys(ACTION_TOOLS).sort()).toEqual([...ALL_TOOL_NAMES].sort());
  });

  it('counts navigations and interactions, and nothing that only reads', () => {
    expect(byKind('navigation')).toEqual([
      'go_back',
      'go_forward',
      'navigate',
      'new_tab',
      'reload',
    ]);
    expect(byKind('interaction')).toEqual([
      'click',
      'download_file',
      'drag_and_drop',
      'fill',
      'hover',
      'press_key',
      'scroll',
      'select_option',
      'type_text',
      'upload_file',
    ]);
    expect(byKind('focus')).toEqual(['switch_tab']);
    for (const read of ['snapshot', 'get_content', 'screenshot', 'wait_for_url', 'evaluate']) {
      expect(actionKindOf(read, {})).toBeNull();
    }
  });

  it('new_tab loads a page only with a url; unknown names are no action', () => {
    expect(actionKindOf('new_tab', { url: 'https://site-a.test/x' })).toBe('navigation');
    expect(actionKindOf('new_tab', {})).toBe('focus');
    expect(actionKindOf('no_such_tool', {})).toBeNull();
  });
});

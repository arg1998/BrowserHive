/** @module features/vault/harnesses/HarnessRuleField.test — the Harnesses field (D-48): All / known / Unknown chips, custom names with the case-sensitive input, seen suggestions, the four warnings, keyboard, axe; and the field's model */
import { describe, expect, it } from 'bun:test';
import type { VaultHarnessesResponse } from '@browserhive/contracts/http';
import { useState } from 'react';
import { expectNoA11yViolations } from '../../../../test/helpers/axe.ts';
import { fireEvent, render, screen } from '../../../../test/helpers/render.tsx';
import { HarnessRuleField } from './HarnessRuleField.tsx';
import {
  addCustomName,
  harnessChips,
  harnessRuleSummary,
  harnessWarnings,
  replaceEntry,
  toggleHarness,
} from './harness-rule.ts';

const SEEN: VaultHarnessesResponse = {
  data: [
    { harness: 'claude-code', label: 'Claude Code', declared: null, sessions: 4, last_seen_at: 3 },
    {
      harness: 'nightly-scraper',
      label: 'nightly-scraper',
      declared: 'Nightly Scraper',
      sessions: 2,
      last_seen_at: 2,
    },
    { harness: 'zed', label: 'Zed', declared: null, sessions: 0, last_seen_at: 1 },
  ],
  principals: 1,
  window: { since: 0, until: 3 },
  now: 3,
};

/** Renders the field with real state, recording every change. */
function renderField(
  initial: readonly string[] | null,
  /** `null`: the seen data has not loaded. */
  seen: VaultHarnessesResponse | null = SEEN,
) {
  const changes: (string[] | null)[] = [];
  function Host() {
    const [value, setValue] = useState<readonly string[] | null>(initial);
    return (
      <HarnessRuleField
        noun="folder"
        value={value}
        seen={seen ?? undefined}
        onChange={(next) => {
          changes.push(next);
          setValue(next);
        }}
      />
    );
  }
  const result = render(<Host />);
  return { ...result, changes };
}

const chip = (name: string | RegExp) => screen.getByRole('button', { name });

describe('HarnessRuleField', () => {
  it('defaults to All harnesses; pressing a harness starts a list of one', async () => {
    const { changes, container } = renderField(null);
    expect(chip('All harnesses').getAttribute('aria-pressed')).toBe('true');
    expect(chip(/^OpenCode/).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('group', { name: 'Harnesses' })).toBeTruthy();
    fireEvent.click(chip(/^OpenCode/));
    expect(changes.at(-1)).toEqual(['opencode']);
    expect(chip('All harnesses').getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(chip(/^Claude Code/));
    expect(changes.at(-1)).toEqual(['opencode', 'claude-code']);
    fireEvent.click(chip('All harnesses'));
    expect(changes.at(-1)).toBeNull();
    expect(
      screen.getByText(/restricts which agents can fill, but does not verify them/),
    ).toBeTruthy();
    await expectNoA11yViolations(container);
  });

  it('marks seen harnesses and keeps the rarer ones behind "More harnesses"', () => {
    renderField(null);
    expect(chip(/^Claude Code \(seen recently\)/)).toBeTruthy();
    expect(chip(/^Zed \(seen recently\)/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Raycast/ })).toBeNull();
    const more = screen.getByRole('button', { name: /More harnesses/ });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(more);
    expect(chip(/^Raycast/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Fewer harnesses' })).toBeTruthy();
  });

  it('unpressing the last harness leaves an empty list with a warning, never All', async () => {
    const { changes, container } = renderField(['opencode']);
    fireEvent.click(chip(/^OpenCode/));
    expect(changes.at(-1)).toEqual([]);
    expect(chip('All harnesses').getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByText('No harness can fill this folder')).toBeTruthy();
    await expectNoA11yViolations(container);
  });

  it('Unknown is its own chip', () => {
    const { changes } = renderField(['claude-code']);
    const unknown = chip(/^Unknown/);
    expect(unknown.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(unknown);
    expect(changes.at(-1)).toEqual(['claude-code', 'unknown']);
  });

  it('adds a custom name through the case-sensitive input, with Enter, and removes it', async () => {
    const { changes, container } = renderField(['claude-code']);
    fireEvent.click(chip('Add custom name'));
    const input = screen.getByRole('textbox', { name: 'Custom harness name' });
    expect(screen.getByText('case-sensitive')).toBeTruthy();
    await expectNoA11yViolations(container);
    fireEvent.change(input, { target: { value: '  Release Bot  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(changes.at(-1)).toEqual(['claude-code', 'Release Bot']);
    expect((input as HTMLInputElement).value).toBe('');
    // A duplicate and a malformed name are refused inline.
    fireEvent.change(input, { target: { value: 'Release Bot' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('alert').textContent).toBe('"Release Bot" is already in the list.');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'Custom harness name' })).toBeNull();
    fireEvent.click(chip('Remove custom name Release Bot'));
    expect(changes.at(-1)).toEqual(['claude-code']);
  });

  it('offers declared names seen on this daemon as one-click suggestions', () => {
    const { changes } = renderField(['claude-code']);
    expect(screen.getByText('Declared here recently:')).toBeTruthy();
    fireEvent.click(chip('Add custom name Nightly Scraper'));
    expect(changes.at(-1)).toEqual(['claude-code', 'Nightly Scraper']);
    expect(screen.queryByRole('button', { name: 'Add custom name Nightly Scraper' })).toBeNull();
  });

  it('warns about a custom name that folds to a built-in harness, and swaps it', () => {
    const { changes } = renderField(['Claude-Code']);
    expect(screen.getByText('"Claude-Code" is matched exactly')).toBeTruthy();
    expect(screen.getByText(/Did you mean the built-in Claude Code\?/)).toBeTruthy();
    fireEvent.click(chip('Use Claude Code'));
    expect(changes.at(-1)).toEqual(['claude-code']);
  });

  it('warns when the list would refuse every recent session, and about one shared principal', () => {
    renderField(['codex']);
    expect(screen.getByText('Would refuse every recent session')).toBeTruthy();
    expect(screen.getByText(/None of the 6 sessions launched here/)).toBeTruthy();
    expect(screen.getByText('Every recent session uses one principal')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Per-agent tokens' }).getAttribute('href')).toContain(
      'mcp-clients',
    );
  });

  it('shows no warnings for All harnesses or before the seen data loads', () => {
    const { unmount } = renderField(null);
    for (const title of [
      'Would refuse every recent session',
      'Every recent session uses one principal',
      'No harness can fill this folder',
    ]) {
      expect(screen.queryByText(title)).toBeNull();
    }
    unmount();
    renderField(['codex'], null);
    expect(screen.queryByText('Would refuse every recent session')).toBeNull();
  });
});

describe('harness rule model', () => {
  it('toggles: from all to one, from one to none', () => {
    expect(toggleHarness(null, 'codex')).toEqual(['codex']);
    expect(toggleHarness(['codex'], 'codex')).toEqual([]);
    expect(toggleHarness(['codex'], 'zed')).toEqual(['codex', 'zed']);
  });

  it('keeps common, selected and seen chips visible', () => {
    const chips = harnessChips(['raycast'], new Set(['zed']));
    const visible = chips.primary.map((c) => c.slug);
    expect(visible).toContain('claude-code');
    expect(visible).toContain('raycast');
    expect(visible).toContain('zed');
    expect(chips.more.map((c) => c.slug)).not.toContain('raycast');
    expect([...visible, ...chips.more.map((c) => c.slug)]).not.toContain('unknown');
  });

  it('adds, validates and replaces custom names', () => {
    expect(addCustomName(null, ' Bot ')).toEqual({ ok: true, list: ['Bot'] });
    expect(addCustomName(['Bot'], 'Bot').ok).toBe(false);
    expect(addCustomName([], '')).toEqual({ ok: false, error: 'A harness name cannot be empty.' });
    expect(addCustomName([], 'x'.repeat(65)).ok).toBe(false);
    expect(replaceEntry(['Claude-Code', 'claude-code'], 'Claude-Code', 'claude-code')).toEqual([
      'claude-code',
    ]);
  });

  it('summarises a list for tables', () => {
    expect(harnessRuleSummary(undefined)).toBeNull();
    expect(harnessRuleSummary(null)).toBeNull();
    expect(harnessRuleSummary([])).toBe('no harness');
    expect(harnessRuleSummary(['claude-code', 'Bot'])).toBe('Claude Code, Bot');
    expect(harnessRuleSummary(['claude-code', 'opencode', 'unknown', 'zed'])).toBe(
      'Claude Code, OpenCode +2',
    );
  });

  it('computes each warning once', () => {
    expect(harnessWarnings(null, SEEN)).toEqual([]);
    expect(harnessWarnings([], SEEN).map((w) => w.kind)).toEqual(['empty', 'shared-principal']);
    expect(harnessWarnings(['claude-code'], { ...SEEN, principals: 2 })).toEqual([]);
    expect(harnessWarnings(['Nightly Scraper'], { ...SEEN, principals: 3 })).toEqual([]);
  });
});

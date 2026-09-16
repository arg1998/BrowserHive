/** @module infra/browsers/humanize/vault-typer.test — vault typer: keyboard cadence with fill fallback. */

import { describe, expect, it } from 'bun:test';
import { seededRng } from './rng.ts';
import { createVaultHumanTyper, type VaultTyperPage } from './vault-typer.ts';

describe('createVaultHumanTyper', () => {
  it('types through the keyboard with a budget-fitted plan when the page is typeable', async () => {
    const events: string[] = [];
    const slept: number[] = [];
    const page = {
      fill: async () => {
        events.push('fill');
      },
      focus: async (selector: string) => {
        events.push(`focus:${selector}`);
      },
      keyboard: {
        type: async (text: string) => {
          events.push(`type:${text}`);
        },
        press: async (key: string) => {
          events.push(`press:${key}`);
        },
      },
    };
    const typer = createVaultHumanTyper({
      rng: seededRng('vault'),
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    await typer(page, '#password', 'hunter2', { timeoutMs: 1_000 });
    expect(events[0]).toBe('focus:#password');
    expect(events).not.toContain('fill');
    const rendered = events
      .slice(1)
      .reduce(
        (acc, e) =>
          e.startsWith('type:')
            ? acc + e.slice(5)
            : e === 'press:Backspace'
              ? acc.slice(0, -1)
              : acc,
        '',
      );
    expect(rendered).toBe('hunter2');
    // Fitted to 80 % of the field budget.
    expect(slept.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(800 + 10);
  });

  it('falls back to fill when the page cannot be typed into (never throws over presentation)', async () => {
    const calls: string[] = [];
    const page: VaultTyperPage = {
      fill: async (selector, value, options) => {
        calls.push(`fill:${selector}:${value}:${options?.timeout ?? 0}`);
      },
    };
    await createVaultHumanTyper()(page, '#pw', 'secret', { timeoutMs: 500 });
    expect(calls).toEqual(['fill:#pw:secret:500']);
  });
});

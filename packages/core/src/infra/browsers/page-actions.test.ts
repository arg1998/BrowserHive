/** @module infra/browsers/page-actions.test — main-world evaluate branching and per-session humanize state of the PageActions adapter. */

import { describe, expect, it } from 'bun:test';
import { FakePage } from '../../../test/helpers/fake-page.ts';
import { createPlaywrightPageActions } from './page-actions.ts';

describe('createPlaywrightPageActions', () => {
  it('passes isolatedContext=false as the fourth positional only for isolated drivers', async () => {
    const actions = createPlaywrightPageActions();
    const page = new FakePage();
    await actions.evaluate(page.page, false, '1 + 1');
    await actions.evaluate(page.page, true, '2 + 2');
    const calls = page.calls.filter((c) => c.method === 'evaluate');
    expect(calls[0]?.args).toEqual(['1 + 1', undefined]);
    expect(calls[1]?.args[0]).toBe('2 + 2');
  });

  it('falls back to the native call when humanize cannot resolve a box', async () => {
    const actions = createPlaywrightPageActions();
    const page = new FakePage();
    let native = 0;
    await actions.humanClick('demo-00000001', {
      page: page.page,
      timeout: 1000,
      selector: '#x',
      native: async () => {
        native++;
      },
    });
    expect(native).toBe(1);
    actions.observeExternalMove('demo-00000001', page.page, 12, 34);
    actions.invalidateCursor('demo-00000001', page.page);
    actions.forgetSession('demo-00000001');
    expect(actions.estimateTypingMs('ab')).toBe(312);
  });

  it('classifies driver prose onto registry codes', () => {
    const actions = createPlaywrightPageActions();
    expect(
      actions.classifyError(new Error('page.goto: net::ERR_NAME_NOT_RESOLVED'), { url: 'x' })?.code,
    ).toBe('NAVIGATION_FAILED');
    expect(actions.classifyError(new Error('something else'), {})).toBeNull();
  });
});

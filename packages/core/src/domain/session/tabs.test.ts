/** @module domain/session/tabs.test — TabRegistry: ids, active tab, resolve fallback, close semantics, popup adoption. */

import { describe, expect, it } from 'bun:test';
import { FakePage } from '../../../test/helpers/fake-page.ts';
import { isAppError } from '../../kernel/errors/app-error.ts';
import { ACTIVE_TAB_SENTINEL, TabRegistry, tabNotFound } from './tabs.ts';

function registry(): TabRegistry {
  let n = 0;
  return new TabRegistry('shop-00000001', () => `t-${String(++n).padStart(6, '0')}`);
}

describe('TabRegistry', () => {
  it('first added page becomes active and ids are minted by the generator', () => {
    const tabs = registry();
    const a = new FakePage();
    const id = tabs.add(a.page);
    expect(id).toBe('t-000001');
    expect(tabs.activeTabId()).toBe(id);
    expect(tabs.activePage()).toBe(a.page);
    expect(tabs.size()).toBe(1);
  });

  it('is idempotent per page', () => {
    const tabs = registry();
    const a = new FakePage();
    expect(tabs.add(a.page)).toBe(tabs.add(a.page));
    expect(tabs.size()).toBe(1);
  });

  it('resolves by id and falls back to the active tab when omitted', () => {
    const tabs = registry();
    const a = new FakePage();
    const b = new FakePage();
    const idA = tabs.add(a.page);
    const idB = tabs.add(b.page);
    expect(tabs.resolve(idB)).toBe(b.page);
    expect(tabs.resolve()).toBe(a.page);
    expect(tabs.resolve(idA)).toBe(a.page);
    expect(tabs.get(idB)).toBe(b.page);
    expect(tabs.has(idB)).toBe(true);
    expect(tabs.idFor(b.page)).toBe(idB);
  });

  it('throws TAB_NOT_FOUND for an unknown id with its public message text', () => {
    const tabs = registry();
    tabs.add(new FakePage().page);
    try {
      tabs.resolve('t-nope00');
      throw new Error('expected a throw');
    } catch (err) {
      expect(isAppError(err, 'TAB_NOT_FOUND')).toBe(true);
      if (!isAppError(err, 'TAB_NOT_FOUND')) return;
      expect(err.message).toBe("Tab 't-nope00' not found in session 'shop-00000001'.");
      expect(err.details).toEqual({ session_id: 'shop-00000001', tab_id: 't-nope00' });
    }
    expect(tabNotFound('s', 't-x').message).toBe("Tab 't-x' not found in session 's'.");
  });

  it('throws TAB_NOT_FOUND with <active> for the fallback when no tabs are open', () => {
    const tabs = registry();
    try {
      tabs.resolve();
      throw new Error('expected a throw');
    } catch (err) {
      expect(isAppError(err, 'TAB_NOT_FOUND')).toBe(true);
      if (isAppError(err, 'TAB_NOT_FOUND')) expect(err.details.tab_id).toBe(ACTIVE_TAB_SENTINEL);
    }
  });

  it('setActive changes the active tab and throws for unknown ids', () => {
    const tabs = registry();
    const a = new FakePage();
    const b = new FakePage();
    tabs.add(a.page);
    const idB = tabs.add(b.page);
    expect(tabs.setActive(idB)).toBe(b.page);
    expect(tabs.activeTabId()).toBe(idB);
    expect(() => tabs.setActive('t-zzzzzz')).toThrow();
  });

  it('removing the active tab promotes the most-recent survivor; ids are never reused', () => {
    const tabs = registry();
    const [a, b, c] = [new FakePage(), new FakePage(), new FakePage()];
    const idA = tabs.add(a.page);
    const idB = tabs.add(b.page);
    const idC = tabs.add(c.page);
    tabs.setActive(idA);
    expect(tabs.remove(idA)).toBe(true);
    expect(tabs.activeTabId()).toBe(idC);
    expect(tabs.remove(idA)).toBe(false);
    expect(tabs.ids()).toEqual([idB, idC]);
    expect(tabs.add(new FakePage().page)).toBe('t-000004');
  });

  it('active becomes undefined when the last tab closes', () => {
    const tabs = registry();
    const id = tabs.add(new FakePage().page);
    tabs.remove(id);
    expect(tabs.activeTabId()).toBeUndefined();
    expect(tabs.activePage()).toBeUndefined();
  });

  it('notifies active-tab changes once per change and stops after unsubscribe', () => {
    const tabs = registry();
    const seen: (string | undefined)[] = [];
    const off = tabs.onActiveChange((id) => seen.push(id));
    tabs.onActiveChange(() => {
      throw new Error('observer failure is ignored');
    });
    const idA = tabs.add(new FakePage().page);
    const idB = tabs.add(new FakePage().page);
    tabs.setActive(idA);
    tabs.setActive(idB);
    tabs.remove(idA);
    tabs.remove(idB);
    expect(seen).toEqual([idA, idB, undefined]);
    off();
    tabs.add(new FakePage().page);
    expect(seen).toHaveLength(3);
  });

  it('entries() preserves insertion order', () => {
    const tabs = registry();
    const pages = [new FakePage(), new FakePage(), new FakePage()];
    const ids = pages.map((p) => tabs.add(p.page));
    expect(tabs.entries().map(([id]) => id)).toEqual(ids);
    expect(tabs.entries().map(([, page]) => page)).toEqual(pages.map((p) => p.page));
  });

  it("auto-removes a tab when the page emits 'close'", async () => {
    const tabs = registry();
    const a = new FakePage();
    const b = new FakePage();
    const idA = tabs.add(a.page);
    tabs.add(b.page);
    await a.close();
    expect(tabs.has(idA)).toBe(false);
    expect(tabs.size()).toBe(1);
  });
});

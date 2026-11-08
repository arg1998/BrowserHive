/** @module domain/vault/fill-target.test — the fill-target gate (D-58, spec 13 T0e): the password goes only into exactly one password input, the username only into one text-like input; every refusal before the fetch makes zero backend calls */

import { beforeEach, describe, expect, it } from 'bun:test';
import {
  createVaultHarness,
  FakePage,
  FakeTracing,
  fakeElement,
  PASSWORD_INPUT,
  SECRET,
  TEXT_INPUT,
  USER,
  type VaultHarness,
} from './test-support.ts';
import type { VaultPage } from './types.ts';

const FILL = { entryName: 'linkedin', usernameSelector: '#u', passwordSelector: '#p' };
const BLOCKED = { status: 'blocked', redacted: true, reason: 'password_target_invalid' } as const;

let h: VaultHarness;
beforeEach(async () => {
  h = createVaultHarness();
  await h.bind('linkedin', {
    itemName: 'linkedin',
    itemId: 'i1',
    allowedOrigins: ['linkedin.com'],
    authorizedSessionSlugs: ['linkedin-agent'],
  });
});

function loginPage(): FakePage {
  return new FakePage('https://linkedin.com/login');
}

/** The password never reached the page, and nothing was fetched from the backend. */
function expectRefusedBeforeFetch(page: FakePage, field: string, problem: string): void {
  expect(h.backend.calls).toEqual([]);
  expect(page.fills).toEqual([]);
  expect(h.repos.audit.rows).toHaveLength(1);
  expect(h.repos.audit.rows[0]).toMatchObject({
    result: 'blocked',
    reason: 'password_target_invalid',
    originCheck: 'pass',
    details: { phase: 'pre_fetch', field, problem },
  });
}

describe('vault fill-target gate — password selector (refused before the fetch)', () => {
  const cases: readonly [string, readonly object[], string][] = [
    ['a text input (a search box)', [fakeElement({ type: 'search' })], 'not_password_input'],
    ['a plain text input', [TEXT_INPUT], 'not_password_input'],
    ['a textarea', [fakeElement({ localName: 'textarea' })], 'not_password_input'],
    [
      'a contenteditable',
      [fakeElement({ localName: 'div', contentEditable: true })],
      'not_password_input',
    ],
    ['two password inputs', [PASSWORD_INPUT, PASSWORD_INPUT], 'multiple_matches'],
    ['nothing', [], 'no_match'],
    ['a hidden password input', [fakeElement({ type: 'password', visible: false })], 'hidden'],
    [
      'a visibility:hidden password input',
      [fakeElement({ type: 'password', styleVisible: false })],
      'hidden',
    ],
    ['a disabled password input', [fakeElement({ type: 'password', disabled: true })], 'disabled'],
    ['a readonly password input', [fakeElement({ type: 'password', readOnly: true })], 'readonly'],
  ];
  for (const [name, elements, problem] of cases) {
    it(`refuses ${name}`, async () => {
      const page = loginPage();
      page.elements.set('#p', elements);
      expect(await h.broker().fill(FILL, h.ctx(page))).toEqual(BLOCKED);
      expectRefusedBeforeFetch(page, 'password', problem);
    });
  }

  it('fails closed on a page that cannot be inspected (no $$eval)', async () => {
    const fills: string[] = [];
    const page: VaultPage = {
      url: () => 'https://linkedin.com/login',
      fill: (_selector, value) => {
        fills.push(value);
        return Promise.resolve();
      },
      click: () => Promise.resolve(),
      $eval: (_selector, fn) => Promise.resolve(fn({ form: null })),
    };
    expect(await h.broker().fill(FILL, h.ctx(page))).toEqual(BLOCKED);
    expect(fills).toEqual([]);
    expect(h.backend.calls).toEqual([]);
    expect(h.repos.audit.rows[0]?.details).toMatchObject({ problem: 'unverifiable' });
  });

  it('fails closed when the inspection throws (bad selector, navigating page)', async () => {
    const page = loginPage();
    page.beforeInspect = () => {
      throw new Error('Unexpected token "<" while parsing selector');
    };
    expect(await h.broker().fill(FILL, h.ctx(page))).toEqual(BLOCKED);
    expectRefusedBeforeFetch(page, 'password', 'unverifiable');
  });

  it('runs before the dashboard confirm: nobody is asked to approve a refused fill', async () => {
    await h.bind('linkedin', {
      itemName: 'linkedin',
      itemId: 'i1',
      allowedOrigins: ['linkedin.com'],
      authorizedSessionSlugs: ['linkedin-agent'],
      dashboardConfirm: true,
    });
    const page = loginPage();
    page.elements.set('#p', [TEXT_INPUT]);
    expect(await h.broker().fill(FILL, h.ctx(page))).toEqual(BLOCKED);
    expect(h.confirm.listOpen('vault_confirm')).toEqual([]);
    expect(h.backend.calls).toEqual([]);
  });

  it('never inspects the page for a caller the earlier gates refuse (no selector oracle)', async () => {
    const page = loginPage();
    const r = await h.broker().fill(FILL, h.ctx(page, { slug: 'other-agent' }));
    expect(r.reason).toBe('not_authorized');
    expect(page.inspected).toEqual([]);
    const off = new FakePage('https://evil.com/login');
    expect((await h.broker().fill(FILL, h.ctx(off))).reason).toBe('origin_mismatch');
    expect(off.inspected).toEqual([]);
  });
});

describe('vault fill-target gate — username selector', () => {
  const cases: readonly [string, readonly object[], string][] = [
    ['a password input', [PASSWORD_INPUT], 'not_text_input'],
    ['a hidden input', [fakeElement({ type: 'hidden' })], 'not_text_input'],
    ['a checkbox', [fakeElement({ type: 'checkbox' })], 'not_text_input'],
    ['a submit button', [fakeElement({ type: 'submit' })], 'not_text_input'],
    ['a textarea', [fakeElement({ localName: 'textarea' })], 'not_text_input'],
    [
      'a contenteditable',
      [fakeElement({ localName: 'div', contentEditable: true })],
      'not_text_input',
    ],
    ['two inputs', [TEXT_INPUT, TEXT_INPUT], 'multiple_matches'],
  ];
  for (const [name, elements, problem] of cases) {
    it(`refuses ${name}`, async () => {
      const page = loginPage();
      page.elements.set('#u', elements);
      expect(await h.broker().fill(FILL, h.ctx(page))).toEqual(BLOCKED);
      expectRefusedBeforeFetch(page, 'username', problem);
    });
  }

  it('accepts every text-like input type', async () => {
    for (const type of ['text', 'email', 'tel', 'search', 'url', 'number']) {
      h = createVaultHarness();
      await h.bind('linkedin', {
        itemName: 'linkedin',
        itemId: 'i1',
        allowedOrigins: ['linkedin.com'],
        authorizedSessionSlugs: ['linkedin-agent'],
      });
      const page = loginPage();
      page.elements.set('#u', [fakeElement({ type })]);
      expect((await h.broker().fill(FILL, h.ctx(page))).status).toBe('success');
    }
  });

  it('a username selector that matches nothing is refused once a username is to be typed', async () => {
    const page = loginPage();
    page.elements.delete('#u');
    expect(await h.broker().fill(FILL, h.ctx(page))).toEqual(BLOCKED);
    expect(page.fills).toEqual([]);
    expect(h.repos.audit.rows[0]?.details).toMatchObject({
      phase: 'pre_fill',
      field: 'username',
      problem: 'no_match',
    });
  });

  it('…and is ignored for an entry without a username (only the password is typed)', async () => {
    h.backend.setCredential('i1', { username: '', password: SECRET });
    const page = loginPage();
    page.elements.delete('#u');
    expect(await h.broker().fill(FILL, h.ctx(page))).toEqual({ status: 'success', redacted: true });
    expect(page.fills).toEqual([['#p', SECRET]]);
  });
});

describe('vault fill-target gate — re-checked immediately before each value', () => {
  it('catches a password input swapped for a text input between the check and the fill', async () => {
    const page = loginPage();
    page.beforeInspect = (selector, count) => {
      if (selector === '#p' && count === 2) page.elements.set('#p', [TEXT_INPUT]);
    };
    expect(await h.broker().fill(FILL, h.ctx(page))).toEqual(BLOCKED);
    expect(page.fills.some(([, value]) => value === SECRET)).toBe(false);
    expect(page.fills.some(([, value]) => value === USER)).toBe(false);
    expect(h.repos.audit.rows).toHaveLength(1);
    expect(h.repos.audit.rows[0]?.details).toMatchObject({
      reason: 'password_target_invalid',
      phase: 'pre_fill',
      field: 'password',
      problem: 'not_password_input',
    });
  });

  it('catches a swap while the username is typed, and clears the username', async () => {
    const page = loginPage();
    page.beforeInspect = (selector, count) => {
      if (selector === '#p' && count === 3) page.elements.set('#p', [TEXT_INPUT]);
    };
    expect(await h.broker().fill(FILL, h.ctx(page))).toEqual(BLOCKED);
    expect(page.fills).toEqual([
      ['#u', USER],
      ['#u', ''],
    ]);
    expect(h.repos.audit.rows[0]?.details).toMatchObject({ phase: 'pre_fill', field: 'password' });
  });

  it('still resumes the trace chunk after a pre-fill refusal', async () => {
    const page = loginPage();
    page.beforeInspect = (selector, count) => {
      if (selector === '#p' && count === 2) page.elements.set('#p', [TEXT_INPUT]);
    };
    const tracing = new FakeTracing();
    expect(await h.broker().fill(FILL, h.ctx(page, { tracing }))).toEqual(BLOCKED);
    expect(tracing.calls).toEqual(['pause', 'resume']);
  });
});

describe('vault fill-target gate — an ordinary login form', () => {
  it('fills, after checking both fields before the fetch and again before each value', async () => {
    const page = loginPage();
    const r = await h.broker().fill({ ...FILL, submitSelector: '#go' }, h.ctx(page));
    expect(r).toEqual({ status: 'success', redacted: true });
    expect(page.fills).toEqual([
      ['#u', USER],
      ['#p', SECRET],
    ]);
    expect(page.clicks).toEqual(['#go']);
    // pre-fetch: password, username; pre-username: password, username; pre-password: password.
    expect(page.inspected).toEqual(['#p', '#u', '#p', '#u', '#p']);
    expect(h.backend.calls.filter((c) => c.startsWith('getEntry'))).toHaveLength(1);
    expect(h.repos.audit.rows[0]).toMatchObject({ result: 'success' });
  });
});

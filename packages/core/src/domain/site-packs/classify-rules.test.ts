/** @module domain/site-packs/classify-rules.test — spec 13 §9.7 for guards, element guards and challenges (added, stricter, restrictive coverage of the probe, the sign-in URL and whole hosts, removed, laxer, match/target/request_guard changes, `write_policy` moves), and the default-deny paths of the classifier's dispatch. */

import { describe, expect, it } from 'bun:test';
import type { SitePackV1Input } from '@browserhive/contracts/site-packs';
import { NO_TEMPLATES } from './classify.ts';
import { classifyField } from './classify-fields.ts';
import { classOf, packWith } from './classify-test-kit.ts';

type Guard = NonNullable<SitePackV1Input['guards']>[number];
type Challenge = NonNullable<SitePackV1Input['challenges']>[number];

const addGuard = (guard: Guard) => (p: SitePackV1Input) => {
  p.guards?.push(guard);
};
const guard = (id: string, url: string, extra: Partial<Guard> = {}): Guard => ({
  id,
  kind: 'account',
  match: { url },
  action: 'block',
  ...extra,
});

describe('guards', () => {
  it('a guard added elsewhere tightens', () => {
    expect(classOf(addGuard(guard('apps', 'www.linkedin.com/developer/apps*'))).fields).toEqual({
      'guards[apps]': 'tightening',
    });
  });

  it('a guard added over the probe path, the sign-in URL or a whole host is restrictive', () => {
    expect(classOf(addGuard(guard('feed', 'www.linkedin.com/feed/*'))).overall).toBe('restrictive');
    expect(classOf(addGuard(guard('login', 'www.linkedin.com/login'))).overall).toBe('restrictive');
    // A sign-in form post is covered too.
    expect(
      classOf(
        addGuard(
          guard('login-post', 'www.linkedin.com/login', {
            match: { url: 'www.linkedin.com/login', methods: ['POST'] },
          }),
        ),
      ).overall,
    ).toBe('restrictive');
    expect(classOf(addGuard(guard('all', 'www.linkedin.com/*'))).overall).toBe('restrictive');
    expect(classOf(addGuard(guard('cdn', '*.licdn.com'))).overall).toBe('restrictive');
  });

  it('a POST-only guard on the probe path does not stop the GET probe; a warn guard never stops', () => {
    expect(
      classOf(
        addGuard(
          guard('feed-post', 'x', { match: { url: 'www.linkedin.com/feed/*', methods: ['POST'] } }),
        ),
      ).overall,
    ).toBe('tightening');
    expect(
      classOf(addGuard(guard('feed-warn', 'www.linkedin.com/feed/*', { action: 'warn' }))).overall,
    ).toBe('tightening');
  });

  it('an action made stricter tightens (warn < confirm < block), restrictive when it covers the probe', () => {
    const action =
      (a: Guard['action'], i = 0) =>
      (p: SitePackV1Input) => {
        const g = p.guards?.[i];
        if (g) g.action = a;
      };
    expect(classOf(action('block'), { before: action('warn') }).fields).toEqual({
      'guards[logout].action': 'tightening',
    });
    expect(classOf(action('confirm'), { before: action('warn') }).overall).toBe('tightening');
    const probeGuard = addGuard(guard('feed', 'www.linkedin.com/feed/*', { action: 'warn' }));
    expect(
      classOf(action('confirm', 3), { before: probeGuard }).fields['guards[feed].action'],
    ).toBe('restrictive');
  });

  it('removed, laxer, a match changed, or any move to or from write_policy loosens', () => {
    expect(classOf((p) => p.guards?.splice(0, 1)).fields).toEqual({
      'guards[logout]': 'loosening',
    });
    expect(
      classOf((p) => {
        const g = p.guards?.[0];
        if (g) g.action = 'confirm';
      }).fields,
    ).toEqual({ 'guards[logout].action': 'loosening' });
    expect(
      classOf((p) => {
        const g = p.guards?.[0];
        if (g) g.match = { url: 'www.linkedin.com/m/logout', methods: ['POST'] };
      }).fields,
    ).toEqual({ 'guards[logout].match.methods': 'loosening' });
    expect(
      classOf((p) => {
        const g = p.guards?.[2];
        if (g) g.action = 'block';
      }).fields,
    ).toEqual({ 'guards[invite].action': 'loosening' });
    expect(
      classOf((p) => {
        const g = p.guards?.[0];
        if (g) g.kind = 'account';
      }).fields,
    ).toEqual({ 'guards[logout].kind': 'loosening' });
  });
});

describe('element guards', () => {
  const element = (id: string, page: string) => (p: SitePackV1Input) => {
    p.element_guards?.push({
      id,
      kind: 'destructive',
      page,
      target: { role: 'button', name: 'Delete' },
      action: 'confirm',
    });
  };
  it('added elsewhere tightens; on the sign-in page, the probe page or a whole host is restrictive', () => {
    expect(classOf(element('delete', 'www.linkedin.com/in/*/edit*')).overall).toBe('tightening');
    expect(classOf(element('delete', 'www.linkedin.com/login')).overall).toBe('restrictive');
    expect(classOf(element('delete', 'www.linkedin.com/feed/')).overall).toBe('restrictive');
    expect(classOf(element('delete', 'www.linkedin.com')).overall).toBe('restrictive');
  });

  it('target, page or request_guard changed, or removed, loosens', () => {
    const edit =
      (fn: (g: NonNullable<SitePackV1Input['element_guards']>[number]) => void) =>
      (p: SitePackV1Input) => {
        const g = p.element_guards?.[0];
        if (g) fn(g);
      };
    expect(classOf(edit((g) => (g.target = { selector: 'a.signout' }))).fields).toEqual({
      'element_guards[signout-button].target.selector': 'loosening',
    });
    expect(classOf(edit((g) => (g.page = 'www.linkedin.com/feed/*'))).overall).toBe('loosening');
    expect(classOf(edit((g) => delete g.request_guard)).fields).toEqual({
      'element_guards[signout-button].request_guard': 'loosening',
    });
    expect(classOf((p) => (p.element_guards = [])).overall).toBe('loosening');
    expect(classOf(edit((g) => (g.action = 'write_policy'))).overall).toBe('loosening');
  });
});

describe('challenges', () => {
  const add =
    (c: Partial<Challenge['match']>, action: Challenge['action'] = 'attention') =>
    (p: SitePackV1Input) => {
      p.challenges?.push({ id: 'wall', kind: 'captcha', match: c, action });
    };
  it('a challenge added elsewhere tightens', () => {
    expect(classOf(add({ url: 'www.linkedin.com/security/*' })).fields).toEqual({
      'challenges[wall]': 'tightening',
    });
    expect(classOf(add({ title_contains: 'Security check' })).overall).toBe('tightening');
  });

  it('restrictive when it covers the probe or sign-in URL, or would match every page', () => {
    expect(classOf(add({ url: 'www.linkedin.com/feed/*' })).overall).toBe('restrictive');
    expect(classOf(add({ url: 'www.linkedin.com/login*' })).overall).toBe('restrictive');
    expect(classOf(add({ url: 'www.linkedin.com/x/*', landmark: 'body' })).overall).toBe(
      'restrictive',
    );
    expect(classOf(add({ url: 'www.linkedin.com/x/*', landmark: ' HTML ' })).overall).toBe(
      'restrictive',
    );
    expect(classOf(add({ url: 'www.linkedin.com/x/*', landmark: ':root' })).overall).toBe(
      'restrictive',
    );
    expect(classOf(add({ text: 'Hi!' })).overall).toBe('restrictive');
    expect(classOf(add({ title_contains: 'In' })).overall).toBe('restrictive');
  });

  it('attention → stop tightens (restrictive when covering); stop → attention loosens', () => {
    const action = (a: Challenge['action']) => (p: SitePackV1Input) => {
      const c = p.challenges?.[0];
      if (c) c.action = a;
    };
    expect(classOf(action('stop')).fields).toEqual({
      'challenges[checkpoint].action': 'tightening',
    });
    expect(classOf(action('attention'), { before: action('stop') }).fields).toEqual({
      'challenges[checkpoint].action': 'loosening',
    });
    const covering = (p: SitePackV1Input) => {
      const c = p.challenges?.[0];
      if (c) c.match = { url: 'www.linkedin.com/feed/*' };
    };
    expect(
      classOf(action('stop'), { before: covering }).fields['challenges[checkpoint].action'],
    ).toBe('restrictive');
  });

  it('removed, its match or kind changed loosens', () => {
    expect(classOf((p) => (p.challenges = [])).overall).toBe('loosening');
    expect(
      classOf((p) => {
        const c = p.challenges?.[0];
        if (c) c.match = { url: 'www.linkedin.com/checkpoint/challenge/*' };
      }).fields,
    ).toEqual({ 'challenges[checkpoint].match.url': 'loosening' });
    expect(
      classOf((p) => {
        const c = p.challenges?.[0];
        if (c) c.kind = 'reauth';
      }).overall,
    ).toBe('loosening');
  });
});

describe('default deny in the dispatch', () => {
  const input = { from: packWith(), to: packWith(), ctx: NO_TEMPLATES };
  it.each([
    'id',
    'schema',
    'future_field',
    'guards',
    'guards[]',
    'guards[logout]x',
    'challenges.0',
    'strategies',
    'strategies[nope]',
    'strategies[serialize-site].future',
    'strategies[serialize-site].params',
    'write_policy.future',
    'concurrency.future',
    'browser.future',
    'consistency.future',
    'sign_in.future',
    'pacing.rules',
    'pacing.future',
  ])('%s is loosening', (path) => {
    expect(classifyField({ path, from: 1, to: 2, class: null }, input)).toBe('loosening');
  });
});

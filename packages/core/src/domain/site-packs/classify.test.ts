/** @module domain/site-packs/classify.test — `classifyPackChange` per field (spec 13 §9.7, §17 T3b): scope, sign-in, write policy, concurrency, pacing, browser, consistency, device binding, keeper, display-only fields, the overall class and every default-deny path outside guards, challenges and strategies (those are in `classify-rules.test.ts` and `classify-strategies.test.ts`). */

import { describe, expect, it } from 'bun:test';
import type { SitePackV1Input as Edit } from '@browserhive/contracts/site-packs';
import { classifyPackChange, strongestClass } from './classify.ts';
import { classOf, packWith } from './classify-test-kit.ts';

const SOURCE = { url: 'https://example.org/limits', kind: 'official' } as const;

describe('overall classification', () => {
  it('is the strongest field: loosening > restrictive > tightening > neutral', () => {
    expect(strongestClass([])).toBe('neutral');
    expect(strongestClass(['neutral', 'tightening'])).toBe('tightening');
    expect(strongestClass(['tightening', 'restrictive', 'neutral'])).toBe('restrictive');
    expect(strongestClass(['restrictive', 'loosening', 'tightening'])).toBe('loosening');
    const mixed = classOf((p) => {
      p.title = 'LinkedIn 2';
      if (p.write_policy !== undefined) p.write_policy.default = 'allow';
    });
    expect(mixed.fields).toEqual({ title: 'neutral', 'write_policy.default': 'loosening' });
    expect(mixed.overall).toBe('loosening');
  });

  it('is neutral for identical content and new_pack (fields unclassified) without an approved version', () => {
    const pack = packWith();
    expect(classifyPackChange(pack, pack)).toEqual({ classification: 'neutral', changes: [] });
    const fresh = classifyPackChange(null, pack);
    expect(fresh.classification).toBe('new_pack');
    expect(fresh.changes.every((c) => c.class === null)).toBe(true);
  });

  it('ignores the version bump itself', () => {
    expect(classOf((p) => (p.version = 9))).toEqual({ overall: 'neutral', fields: {} });
  });
});

describe('display-only fields are neutral', () => {
  it.each([
    ['title', (p: Edit) => (p.title = 'LinkedIn (new)')],
    ['description', (p: Edit) => (p.description = 'Jobs')],
    ['min_client', (p: Edit) => (p.min_client = '0.4.0')],
    ['max_client', (p: Edit) => (p.max_client = '9.0.0')],
    ['verified.guards', (p: Edit) => (p.verified = { guards: '2026-11-01' })],
    ['sources', (p: Edit) => (p.sources = [SOURCE])],
  ])('%s', (path, edit) => {
    const result = classOf(edit);
    expect(result.overall).toBe('neutral');
    expect(Object.keys(result.fields).some((k) => k.startsWith(path.split('.')[0] ?? path))).toBe(
      true,
    );
  });
});

describe('scope and identity fields are loosening', () => {
  it('a domain added or removed', () => {
    expect(classOf((p) => p.domains?.push('lnkd.in')).fields).toEqual({ domains: 'loosening' });
    expect(classOf((p) => (p.domains = ['linkedin.com'])).fields).toEqual({
      domains: 'loosening',
    });
  });

  it('identity_provider and shares_login_with, any change', () => {
    expect(classOf((p) => (p.identity_provider = 'google.com')).fields).toEqual({
      identity_provider: 'loosening',
    });
    expect(classOf((p) => (p.shares_login_with = ['licdn.com'])).fields).toEqual({
      shares_login_with: 'loosening',
    });
  });
});

describe('sign-in and probe', () => {
  it('sign_in.url, sign_in.form and signed_in.* are loosening', () => {
    expect(
      classOf((p) => {
        if (p.sign_in) p.sign_in.url.path = '/uas/login';
      }).fields,
    ).toEqual({ 'sign_in.url.path': 'loosening' });
    expect(
      classOf((p) => {
        if (p.sign_in) p.sign_in.form = { username: '#username', password: '#password' };
      }).fields,
    ).toEqual({ 'sign_in.form': 'loosening' });
    expect(
      classOf((p) => {
        p.signed_in.probe.path = '/me/';
        p.signed_in.cookie_names = ['li_at'];
        p.signed_in.session_lifetime_days = 365;
      }).fields,
    ).toEqual({
      'signed_in.probe.path': 'loosening',
      'signed_in.cookie_names': 'loosening',
      'signed_in.session_lifetime_days': 'loosening',
    });
  });

  it('human_only false → true tightens, true → false loosens', () => {
    const on = (p: Edit) => {
      if (p.sign_in) p.sign_in.human_only = true;
    };
    expect(classOf(on).fields).toEqual({ 'sign_in.human_only': 'tightening' });
    expect(
      classOf(
        (p) => {
          if (p.sign_in) p.sign_in.human_only = false;
        },
        { before: on },
      ).fields,
    ).toEqual({ 'sign_in.human_only': 'loosening' });
  });

  it('default deny: sign_in removed, a pack id or schema change', () => {
    expect(
      classOf((p) => {
        delete p.sign_in;
        p.identity_provider = 'google.com';
      }).fields,
    ).toEqual({ sign_in: 'loosening', identity_provider: 'loosening' });
  });
});

describe('write_policy', () => {
  it('default stricter tightens (allow < warn < confirm), laxer loosens', () => {
    const set = (v: 'allow' | 'warn' | 'confirm') => (p: Edit) => {
      p.write_policy.default = v;
    };
    expect(classOf(set('confirm'), { before: set('warn') }).fields).toEqual({
      'write_policy.default': 'tightening',
    });
    expect(classOf(set('warn'), { before: set('allow') }).overall).toBe('tightening');
    expect(classOf(set('warn')).fields).toEqual({ 'write_policy.default': 'loosening' });
  });

  it('stance, clause and exception are neutral', () => {
    const result = classOf((p) => {
      p.write_policy.stance = 'restricted';
      p.write_policy.exception = 'The site allows bots for read access.';
      p.write_policy.clause = { quote: 'No bots.', url: 'https://x.test/t', checked: '2026-10-01' };
    });
    expect(result.overall).toBe('neutral');
    expect(Object.values(result.fields)).toEqual(['neutral', 'neutral', 'neutral']);
  });
});

describe('concurrency', () => {
  const cap = (n: number) => (p: Edit) => {
    p.concurrency = { max_sessions: n, source: SOURCE };
  };
  it('lowered tightens, lowered to 1 is restrictive, raised loosens', () => {
    expect(classOf(cap(2), { before: cap(4) }).fields).toEqual({
      'concurrency.max_sessions': 'tightening',
    });
    expect(classOf(cap(1), { before: cap(4) }).fields).toEqual({
      'concurrency.max_sessions': 'restrictive',
    });
    expect(classOf(cap(5), { before: cap(4) }).fields).toEqual({
      'concurrency.max_sessions': 'loosening',
    });
  });

  it('a cap added tightens (restrictive at 1); removed loosens; source is neutral', () => {
    expect(classOf(cap(3)).fields).toEqual({ concurrency: 'tightening' });
    expect(classOf(cap(1)).fields).toEqual({ concurrency: 'restrictive' });
    expect(classOf((p) => delete p.concurrency, { before: cap(3) }).fields).toEqual({
      concurrency: 'loosening',
    });
    expect(
      classOf(
        (p) => {
          if (p.concurrency) p.concurrency.source = { url: 'https://x.test/b', kind: 'vendor' };
        },
        { before: cap(3) },
      ).overall,
    ).toBe('neutral');
  });
});

describe('pacing', () => {
  const rule = (limit: number) => (p: Edit) => {
    const r = p.pacing?.rules?.[0];
    if (r) r.limit = limit;
  };
  it('a rule limit lowered tightens, lowered to 1 is restrictive, raised loosens', () => {
    expect(classOf(rule(50)).fields).toEqual({ 'pacing.rules[invites].limit': 'tightening' });
    expect(classOf(rule(1)).fields).toEqual({ 'pacing.rules[invites].limit': 'restrictive' });
    expect(classOf(rule(200)).fields).toEqual({ 'pacing.rules[invites].limit': 'loosening' });
  });

  it('a rule added tightens (restrictive at 1), removed loosens, its source is neutral', () => {
    const add = (limit: number) => (p: Edit) => {
      p.pacing?.rules?.push({
        id: 'invites-day',
        guard: 'invite',
        per: 'day',
        limit,
        kind: 'official',
        source: SOURCE,
      });
    };
    expect(classOf(add(20)).fields).toEqual({ 'pacing.rules[invites-day]': 'tightening' });
    expect(classOf(add(1)).fields).toEqual({ 'pacing.rules[invites-day]': 'restrictive' });
    expect(
      classOf((p) => {
        if (p.pacing) p.pacing.rules = [];
      }).fields,
    ).toEqual({ 'pacing.rules[invites]': 'loosening' });
    expect(
      classOf((p) => {
        const r = p.pacing?.rules?.[0];
        if (r) r.source = { url: 'https://example.org/other', kind: 'official' };
      }).overall,
    ).toBe('neutral');
  });

  it('default deny: a rule period, guard or kind changed', () => {
    expect(
      classOf((p) => {
        const r = p.pacing?.rules?.[0];
        if (r) {
          r.per = 'day';
          r.kind = 'official';
        }
      }).fields,
    ).toEqual({
      'pacing.rules[invites].per': 'loosening',
      'pacing.rules[invites].kind': 'loosening',
    });
  });

  it('min_launch_gap_s raised tightens, lowered loosens; pacing added or removed', () => {
    const gap = (n: number) => (p: Edit) => {
      if (p.pacing) p.pacing.min_launch_gap_s = n;
    };
    expect(classOf(gap(60)).fields).toEqual({ 'pacing.min_launch_gap_s': 'tightening' });
    expect(classOf(gap(10), { before: gap(60) }).fields).toEqual({
      'pacing.min_launch_gap_s': 'loosening',
    });
    expect(classOf((p) => delete p.pacing).fields).toEqual({ pacing: 'loosening' });
    const noPacing = (p: Edit) => delete p.pacing;
    expect(classOf(gap(30), { before: noPacing }).fields).toEqual({});
    expect(
      classOf((p) => (p.pacing = { rules: [], min_launch_gap_s: 30 }), { before: noPacing }).fields,
    ).toEqual({ pacing: 'tightening' });
  });
});

describe('browser and consistency', () => {
  const headed = (v: 'any' | 'preferred' | 'required') => (p: Edit) => {
    p.browser = { headed: v };
  };
  it('headed stricter tightens; required added is restrictive; laxer loosens', () => {
    expect(classOf(headed('preferred')).fields).toEqual({ 'browser.headed': 'tightening' });
    expect(classOf(headed('required')).fields).toEqual({ 'browser.headed': 'restrictive' });
    expect(classOf(headed('required'), { before: headed('preferred') }).overall).toBe(
      'restrictive',
    );
    expect(classOf(headed('any'), { before: headed('preferred') }).fields).toEqual({
      'browser.headed': 'loosening',
    });
  });

  it('channel: any change is loosening', () => {
    expect(classOf((p) => (p.browser = { channel: 'chrome' })).fields).toEqual({
      'browser.channel': 'loosening',
    });
  });

  it('proxy stricter tightens, laxer loosens; pin_* false → true tightens, true → false loosens', () => {
    const proxy = (v: 'any' | 'recommended') => (p: Edit) => {
      p.consistency = { proxy: v };
    };
    expect(classOf(proxy('recommended')).fields).toEqual({ 'consistency.proxy': 'tightening' });
    expect(classOf(proxy('any'), { before: proxy('recommended') }).fields).toEqual({
      'consistency.proxy': 'loosening',
    });
    const pins = (v: boolean) => (p: Edit) => {
      p.consistency = { pin_geo: v, pin_timezone: v, pin_locale: v };
    };
    expect(classOf(pins(true), { before: pins(false) }).fields).toEqual({
      'consistency.pin_geo': 'tightening',
      'consistency.pin_timezone': 'tightening',
      'consistency.pin_locale': 'tightening',
    });
    expect(classOf(pins(false)).overall).toBe('loosening');
  });
});

describe('device_binding', () => {
  const entry = (platform: 'windows' | 'macos', since?: string) => ({
    platform,
    mechanism: 'dbsc' as const,
    source: SOURCE,
    ...(since !== undefined && { since }),
  });
  it('an entry added tightens, removed loosens, its since or source alone is neutral', () => {
    const one = (p: Edit) => {
      p.device_binding = [entry('windows')];
    };
    expect(classOf(one).fields).toEqual({ 'device_binding[0]': 'tightening' });
    // Inserted in front: position diffs, but nothing was removed.
    const two = classOf((p) => (p.device_binding = [entry('macos'), entry('windows')]), {
      before: one,
    });
    expect(two.overall).toBe('tightening');
    expect(classOf((p) => (p.device_binding = []), { before: one }).fields).toEqual({
      'device_binding[0]': 'loosening',
    });
    expect(
      classOf((p) => (p.device_binding = [entry('windows', '2026-05-25')]), { before: one })
        .overall,
    ).toBe('neutral');
  });
});

describe('keeper', () => {
  const keeper = (hours: number, path?: string) => (p: Edit) => {
    p.keeper = { interval_hours: hours, ...(path !== undefined && { path }) };
  };
  it('interval raised tightens, lowered loosens; path changed loosens', () => {
    expect(classOf(keeper(48), { before: keeper(24) }).fields).toEqual({
      'keeper.interval_hours': 'tightening',
    });
    expect(classOf(keeper(12), { before: keeper(24) }).fields).toEqual({
      'keeper.interval_hours': 'loosening',
    });
    expect(classOf(keeper(24, '/feed/'), { before: keeper(24) }).fields).toEqual({
      'keeper.path': 'loosening',
    });
  });

  it('default deny: a keeper added or removed', () => {
    expect(classOf(keeper(24)).fields).toEqual({ keeper: 'loosening' });
    expect(classOf((p) => delete p.keeper, { before: keeper(24) }).fields).toEqual({
      keeper: 'loosening',
    });
  });
});

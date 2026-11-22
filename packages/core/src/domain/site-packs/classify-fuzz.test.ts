/** @module domain/site-packs/classify-fuzz.test — a seeded property test of `classifyPackChange` (spec 13 §9.7, D-73; adopted from the review of PR #84): random candidates built from the bundled packs and the fixture pack by mutation families that truly loosen, that can stop the site, or that only tighten or describe. A candidate with any loosening mutation classifies `loosening`; one with a stopping mutation and no loosening one classifies at least `restrictive`; one with neither is at most `tightening` (a routine guard on the sign-in host of a pack that declares `sign_in.post` included: review #84 N4; any change of `sign_in.post` is loosening). Plus the reviewer's probes on the bundled LinkedIn pack, each `restrictive`. */

import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PACE_CEILING, SitePackV1, type SitePackV1Input } from '@browserhive/contracts/site-packs';
import { classifyPackChange } from './classify.ts';
import { refinePack } from './refine.ts';
import { basePack } from './test-fixtures.ts';

type Pack = SitePackV1Input;
type Guard = NonNullable<Pack['guards']>[number];
type Challenge = NonNullable<Pack['challenges']>[number];
type Strategy = NonNullable<Pack['strategies']>[number];

const PACKS_DIR = join(import.meta.dir, '../../../../../registry/packs');

function bundled(file: string): Pack {
  return SitePackV1.parse(JSON.parse(readFileSync(join(PACKS_DIR, file), 'utf8')));
}

/** The fixture pack with its challenge stopping the site (no bundled pack stops one yet). */
function stoppingBase(): Pack {
  const pack = basePack();
  for (const c of pack.challenges ?? []) c.action = 'stop';
  return pack;
}

/** The fixture pack declaring its sign-in form's post target (review #84 N4). */
function postingBase(): Pack {
  const pack = basePack();
  if (pack.sign_in !== undefined) {
    pack.sign_in.post = [
      'www.linkedin.com/checkpoint/lg/login-submit',
      'www.linkedin.com/checkpoint/challenge/verify*',
    ];
  }
  return pack;
}

const BASES: readonly Pack[] = [
  basePack(),
  stoppingBase(),
  postingBase(),
  ...readdirSync(PACKS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map(bundled),
];

/** A deterministic generator (the run is reproducible). */
function generator(seed: number) {
  let state = seed;
  const next = () => {
    state = (state * 1_103_515_245 + 12_345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  return {
    next,
    pick<T>(items: readonly T[]): T {
      const item = items[Math.floor(next() * items.length)];
      if (item === undefined) throw new Error('pick from an empty list');
      return item;
    },
  };
}
type Rng = ReturnType<typeof generator>;

/** What a mutation does to the candidate's class. */
type Effect = 'loosens' | 'can_stop' | 'tightens_or_describes';

interface Mutation {
  readonly name: string;
  readonly effect: Effect;
  /** Edits `p` (a copy of `base`); `false` when it does not apply to this pack. */
  readonly apply: (p: Pack, rng: Rng, base: Pack) => boolean;
}

const host = (p: Pack) => p.signed_in.probe.host;
const strategy = (p: Pack, id: Strategy['id']) => p.strategies?.find((s) => s.id === id);
const setParams = (s: Strategy, params: Strategy['params']) => {
  s.params = { ...s.params, ...params };
};
const blockingGuard = (p: Pack) =>
  p.guards?.find((g) => g.action === 'block' || g.action === 'confirm');
const challenge = (p: Pack, c: Challenge) => {
  p.challenges = [...(p.challenges ?? []), c];
  return true;
};

const LOOSENING: readonly Mutation[] = [
  {
    name: 'guard removed',
    effect: 'loosens',
    apply: (p, rng) => {
      if (!p.guards?.length) return false;
      p.guards.splice(Math.floor(rng.next() * p.guards.length), 1);
      return true;
    },
  },
  {
    name: 'guard action laxer',
    effect: 'loosens',
    apply: (p, rng) => {
      const g = blockingGuard(p);
      if (g === undefined) return false;
      g.action = g.action === 'block' ? rng.pick(['confirm', 'warn'] as const) : 'warn';
      return true;
    },
  },
  {
    name: 'guard url narrowed',
    effect: 'loosens',
    apply: (p) => {
      const g = p.guards?.[0];
      if (g === undefined) return false;
      g.match.url = g.match.url.replace(/\*?$/, 'zzz');
      return true;
    },
  },
  {
    name: 'guard methods narrowed',
    effect: 'loosens',
    apply: (p) => {
      const g = p.guards?.find((x) => x.match.methods === undefined);
      if (g === undefined) return false;
      g.match.methods = ['DELETE'];
      return true;
    },
  },
  {
    name: 'guard resource types narrowed',
    effect: 'loosens',
    apply: (p) => {
      const g = p.guards?.[0];
      if (g === undefined) return false;
      g.match.resource_types = ['ping'];
      return true;
    },
  },
  {
    name: 'guard renamed',
    effect: 'loosens',
    apply: (p) => {
      const g = p.guards?.[0];
      if (g === undefined) return false;
      g.id = 'zz-renamed';
      g.match.url = `${g.match.url}q`;
      return true;
    },
  },
  {
    name: 'guard to write_policy',
    effect: 'loosens',
    apply: (p) => {
      const g = p.guards?.find((x) => x.action !== 'write_policy');
      if (g === undefined) return false;
      g.kind = 'write';
      g.action = 'write_policy';
      return true;
    },
  },
  {
    name: 'element guard removed',
    effect: 'loosens',
    apply: (p) => {
      if (!p.element_guards?.length) return false;
      p.element_guards.pop();
      return true;
    },
  },
  {
    name: 'challenge removed',
    effect: 'loosens',
    apply: (p) => {
      if (!p.challenges?.length) return false;
      p.challenges.pop();
      return true;
    },
  },
  {
    name: 'challenge stop → attention',
    effect: 'loosens',
    apply: (p) => {
      const c = p.challenges?.find((x) => x.action === 'stop');
      if (c === undefined) return false;
      c.action = 'attention';
      return true;
    },
  },
  {
    name: 'challenge url changed',
    effect: 'loosens',
    apply: (p) => {
      const c = p.challenges?.find((x) => x.match.url !== undefined);
      if (c?.match.url === undefined) return false;
      c.match.url = `${c.match.url}x`;
      return true;
    },
  },
  {
    name: 'domain added',
    effect: 'loosens',
    apply: (p) => {
      if (p.domains.length >= 8) return false;
      p.domains.push('zz-extra.com');
      return true;
    },
  },
  {
    name: 'domain removed',
    effect: 'loosens',
    apply: (p) => {
      if (p.domains.length < 2) return false;
      const gone = p.domains.pop() ?? '';
      const keep = (url: string) => !url.includes(gone);
      p.guards = (p.guards ?? []).filter((g) => keep(g.match.url));
      p.element_guards = (p.element_guards ?? []).filter((g) => keep(g.page));
      p.challenges = (p.challenges ?? []).filter(
        (c) => c.match.url === undefined || keep(c.match.url),
      );
      return true;
    },
  },
  {
    name: 'human_only true → false',
    effect: 'loosens',
    apply: (p) => {
      if (p.sign_in?.human_only !== true) return false;
      p.sign_in.human_only = false;
      return true;
    },
  },
  {
    name: 'sign-in path',
    effect: 'loosens',
    apply: (p) => {
      if (p.sign_in === undefined) return false;
      p.sign_in.url.path = `${p.sign_in.url.path}x`;
      return true;
    },
  },
  {
    name: 'probe path',
    effect: 'loosens',
    apply: (p) => {
      p.signed_in.probe.path = p.signed_in.probe.path.replace(/\/?$/, '/x');
      return true;
    },
  },
  {
    name: 'write default laxer',
    effect: 'loosens',
    apply: (p) => {
      const d = p.write_policy.default;
      if (d === 'allow') return false;
      p.write_policy.default = d === 'confirm' ? 'warn' : 'allow';
      p.write_policy.exception = 'review fuzzing exception text';
      return true;
    },
  },
  {
    name: 'headed laxer',
    effect: 'loosens',
    apply: (p) => {
      if (p.browser?.headed === undefined || p.browser.headed === 'any') return false;
      p.browser.headed = 'any';
      return true;
    },
  },
  {
    name: 'channel changed',
    effect: 'loosens',
    apply: (p) => {
      const channel = p.browser?.channel ?? 'any';
      p.browser = { ...p.browser, channel: channel === 'any' ? 'chrome' : 'any' };
      return true;
    },
  },
  {
    name: 'pin_geo off',
    effect: 'loosens',
    apply: (p) => {
      if (p.consistency?.pin_geo === false) return false;
      p.consistency = { ...p.consistency, pin_geo: false };
      return true;
    },
  },
  {
    name: 'strategy removed',
    effect: 'loosens',
    apply: (p, rng) => {
      if (!p.strategies?.length) return false;
      p.strategies.splice(Math.floor(rng.next() * p.strategies.length), 1);
      return true;
    },
  },
  {
    name: 'dwell lowered',
    effect: 'loosens',
    apply: (p) => {
      const s = strategy(p, 'human-dwell');
      if (s === undefined) return false;
      setParams(s, { min_ms: 100 });
      return true;
    },
  },
  {
    name: 'serialize raised',
    effect: 'loosens',
    apply: (p) => {
      const s = strategy(p, 'serialize-site');
      if (s === undefined) return false;
      setParams(s, { max_parallel: 3 });
      return true;
    },
  },
  {
    name: 'launch gap lowered',
    effect: 'loosens',
    apply: (p) => {
      const s = strategy(p, 'launch-spacing');
      if (s === undefined) return false;
      setParams(s, { min_gap_s: 1 });
      return true;
    },
  },
  {
    name: 'ramp start raised',
    effect: 'loosens',
    apply: (p) => {
      const s = strategy(p, 'ramp-up');
      if (s === undefined) return false;
      setParams(s, { start_fraction: 0.9 });
      return true;
    },
  },
  {
    name: 'keep-alive interval lowered (via keeper)',
    effect: 'loosens',
    apply: (p) => {
      if (strategy(p, 'keep-alive') === undefined) return false;
      p.keeper = { interval_hours: 6 };
      return true;
    },
  },
  {
    name: 'pace rule removed',
    effect: 'loosens',
    apply: (p) => {
      if (!p.pacing?.rules?.length) return false;
      p.pacing.rules.pop();
      return true;
    },
  },
  {
    name: 'pace limit raised',
    effect: 'loosens',
    apply: (p) => {
      const r = p.pacing?.rules?.[0];
      if (r === undefined) return false;
      r.limit *= 2;
      return true;
    },
  },
  {
    name: 'pace period changed',
    effect: 'loosens',
    apply: (p) => {
      // Any change of `per` is loosening (default deny), whichever way.
      const r = p.pacing?.rules?.[0];
      if (r === undefined) return false;
      r.per = r.per === 'week' ? 'day' : 'week';
      r.limit = Math.min(r.limit, PACE_CEILING[r.per]);
      return true;
    },
  },
  {
    name: 'shares_login_with',
    effect: 'loosens',
    apply: (p) => {
      p.shares_login_with = ['zz-share.com'];
      return true;
    },
  },
  {
    name: 'signed-out redirect added',
    effect: 'loosens',
    apply: (p) => {
      p.signed_in.signed_out_redirects = [
        ...(p.signed_in.signed_out_redirects ?? []),
        `${host(p)}/zz*`,
      ];
      return true;
    },
  },
  {
    name: 'sign-in post target changed',
    effect: 'loosens',
    apply: (p, rng) => {
      const signIn = p.sign_in;
      if (signIn === undefined) return false;
      const post = signIn.post;
      if (post === undefined) {
        signIn.post = [`${signIn.url.host}/zz-session`];
        return true;
      }
      const how = rng.pick(['removed', 'moved', 'added', 'dropped'] as const);
      if (how === 'removed') delete signIn.post;
      else if (how === 'moved') post[0] = `${signIn.url.host}/zz-moved`;
      else if (how === 'added' && post.length < 4) post.push(`${signIn.url.host}/zz-also`);
      else if (post.length > 1) post.pop();
      else delete signIn.post;
      return true;
    },
  },
  {
    name: 'device binding removed',
    effect: 'loosens',
    apply: (p) => {
      if (!p.device_binding?.length) return false;
      p.device_binding.pop();
      return true;
    },
  },
];

/** Mutations that can stop the site (D-73, review #84 M2): each is `restrictive` at least. */
const CAN_STOP: readonly Mutation[] = [
  ...(
    [
      ['title_contains', { title_contains: 'Security check' }],
      ['landmark div', { landmark: 'div' }],
      ['landmark html > body', { landmark: 'html > body' }],
      ['landmark body *', { landmark: 'body *' }],
      ['landmark meta, div', { landmark: 'meta, div' }],
      ['text', { text: 'Home' }],
      ['frame', { frame: 'recaptcha' }],
    ] as const
  ).map(
    ([name, match]): Mutation => ({
      name: `content-only challenge (${name})`,
      effect: 'can_stop',
      apply: (p, rng) =>
        challenge(p, {
          id: 'zz-content',
          kind: 'locked',
          match,
          action: rng.pick(['attention', 'stop'] as const),
        }),
    }),
  ),
  {
    name: 'stop challenge anchored elsewhere',
    effect: 'can_stop',
    apply: (p) =>
      challenge(p, {
        id: 'zz-stop',
        kind: 'locked',
        match: { url: `${host(p)}/zz-locked*` },
        action: 'stop',
      }),
  },
  {
    name: 'challenge over a whole host',
    effect: 'can_stop',
    apply: (p) =>
      challenge(p, {
        id: 'zz-all',
        kind: 'captcha',
        match: { url: `${host(p)}/*` },
        action: 'attention',
      }),
  },
  {
    name: 'challenge attention → stop',
    effect: 'can_stop',
    apply: (p) => {
      const c = p.challenges?.find((x) => x.action === 'attention');
      if (c === undefined) return false;
      c.action = 'stop';
      return true;
    },
  },
  {
    name: 'guard blocking a post on the sign-in host (no sign_in.post)',
    effect: 'can_stop',
    apply: (p) => {
      const signIn = p.sign_in?.url.host;
      if (signIn === undefined || p.sign_in?.post !== undefined) return false;
      const guard: Guard = {
        id: 'zz-submit',
        kind: 'account',
        match: { url: `${signIn}/zz/login-submit*`, methods: ['POST'] },
        action: 'block',
      };
      p.guards = [...(p.guards ?? []), guard];
      return true;
    },
  },
  {
    name: 'guard on a declared sign-in post target',
    effect: 'can_stop',
    apply: (p, rng) => {
      const target = p.sign_in?.post?.[0];
      if (target === undefined) return false;
      // The target itself, a wider glob over it, its folder, or a wildcard first host label
      // (`github.com/session` → `*.com/…` is refused by refinePack and skipped).
      const url = rng.pick([
        target,
        `${target.replace(/\*$/, '')}*`,
        `${target.slice(0, target.lastIndexOf('/'))}/*`,
        target.replace(/^[^./]+\./, '*.'),
      ]);
      const guard: Guard = {
        id: 'zz-post',
        kind: rng.pick(['account', 'credential', 'write'] as const),
        match: {
          url,
          ...(rng.next() < 0.5 && {
            methods: rng.pick([['POST'], ['POST', 'PUT']] as const).slice(),
          }),
        },
        action: rng.pick(['block', 'confirm'] as const),
      };
      p.guards = [...(p.guards ?? []), guard];
      return true;
    },
  },
];

/** A routine guard on the sign-in host away from the declared post targets: tightening only. */
const ROUTINE_WITH_POST: Mutation = {
  name: 'routine guard on the sign-in host, sign_in.post declared elsewhere',
  effect: 'tightens_or_describes',
  apply: (p, rng) => {
    const signIn = p.sign_in;
    if (signIn?.post === undefined) return false;
    const h = signIn.url.host;
    const guard: Guard = rng.pick<Guard>([
      { id: 'zz-logout', kind: 'logout', match: { url: `${h}/zz-logout` }, action: 'block' },
      { id: 'zz-settings', kind: 'account', match: { url: `${h}/zz-settings*` }, action: 'block' },
      {
        id: 'zz-write',
        kind: 'write',
        match: { url: `${h}/zz-api/*`, methods: ['POST'] },
        action: 'confirm',
      },
    ]);
    p.guards = [...(p.guards ?? []), guard];
    return true;
  },
};

const TIGHTENING_OR_DESCRIPTIVE: readonly Mutation[] = [
  ROUTINE_WITH_POST,
  {
    name: 'title',
    effect: 'tightens_or_describes',
    apply: (p) => {
      p.title = 'Changed';
      return true;
    },
  },
  {
    name: 'description',
    effect: 'tightens_or_describes',
    apply: (p) => {
      p.description = 'Changed description';
      return true;
    },
  },
  {
    name: 'GET guard added',
    effect: 'tightens_or_describes',
    apply: (p) => {
      const guard: Guard = {
        id: 'zz-added',
        kind: 'account',
        match: { url: `${host(p)}/zz-added-path`, methods: ['GET'] },
        action: 'block',
      };
      p.guards = [...(p.guards ?? []), guard];
      return true;
    },
  },
  {
    name: 'attention challenge anchored elsewhere',
    effect: 'tightens_or_describes',
    apply: (p) =>
      challenge(p, {
        id: 'zz-check',
        kind: 'checkpoint',
        match: { url: `${host(p)}/zz-check*` },
        action: 'attention',
      }),
  },
  {
    name: 'strategy added',
    effect: 'tightens_or_describes',
    apply: (p, rng, base) => {
      // Never one the base had: removing it and adding it back changes nothing.
      const have = new Set([...(p.strategies ?? []), ...(base.strategies ?? [])].map((s) => s.id));
      const free = (
        ['humanize-input', 'single-focus', 'device-bound-session', 'webrtc-policy'] as const
      ).filter((id) => !have.has(id));
      if (free.length === 0 || (p.strategies?.length ?? 0) >= 8) return false;
      p.strategies = [...(p.strategies ?? []), { id: rng.pick(free), params: {} }];
      return true;
    },
  },
  {
    name: 'verified',
    effect: 'tightens_or_describes',
    apply: (p) => {
      p.verified = { ...p.verified, guards: '2027-01-01' };
      return true;
    },
  },
  {
    name: 'min_client',
    effect: 'tightens_or_describes',
    apply: (p) => {
      p.min_client = '9.9.9';
      return true;
    },
  },
];

const RANK: Readonly<Record<string, number>> = {
  neutral: 0,
  tightening: 1,
  restrictive: 2,
  loosening: 3,
};

describe('classifyPackChange, a seeded property test', () => {
  it('loosening stays loosening; what can stop the site is at least restrictive; the rest is at most tightening', () => {
    const rng = generator(12_345);
    const failures: string[] = [];
    let ran = 0;
    const seen = new Set<string>();
    // Each base is parsed and refined once, not once per case (the candidate still is).
    const parsedBases = new Map(
      BASES.map((b) => {
        const from = SitePackV1.parse(b);
        expect(refinePack(from).issues).toEqual([]);
        return [b, from] as const;
      }),
    );
    for (let i = 0; i < 5000; i += 1) {
      const picked = rng.pick(BASES);
      const base = structuredClone(picked);
      const from = parsedBases.get(picked) ?? SitePackV1.parse(base);
      const candidate = structuredClone(base);
      candidate.version = from.version + 1;
      const applied: Mutation[] = [];
      const tryApply = (m: Mutation) => {
        const before = JSON.stringify(candidate);
        if (m.apply(candidate, rng, base) && JSON.stringify(candidate) !== before) applied.push(m);
      };
      const roll = rng.next();
      if (roll < 0.5) tryApply(rng.pick(LOOSENING));
      else if (roll < 0.8) tryApply(rng.pick(CAN_STOP));
      const noise = 1 + Math.floor(rng.next() * 3);
      for (let j = 0; j < noise; j += 1) tryApply(rng.pick(TIGHTENING_OR_DESCRIPTIVE));
      if (applied.length === 0) continue;
      const parsed = SitePackV1.safeParse(candidate);
      if (!parsed.success || refinePack(parsed.data).issues.length > 0) continue;
      ran += 1;
      for (const m of applied) seen.add(m.name);
      const result = classifyPackChange(from, parsed.data);
      const strongest = applied.some((m) => m.effect === 'loosens')
        ? 'loosening'
        : applied.some((m) => m.effect === 'can_stop')
          ? 'restrictive'
          : null;
      const got = RANK[result.classification] ?? -1;
      const bad =
        strongest === 'loosening'
          ? result.classification !== 'loosening'
          : strongest === 'restrictive'
            ? got < 2 // below restrictive
            : got > 1; // tightening or descriptive changes: never restrictive or loosening
      if (bad) {
        failures.push(
          `${base.id}: [${applied.map((m) => m.name).join(', ')}] → ${result.classification}`,
        );
      }
    }
    expect(failures.slice(0, 10)).toEqual([]);
    // Enough valid candidates, and every family applied somewhere.
    expect(ran).toBeGreaterThan(3000);
    for (const m of [...LOOSENING, ...CAN_STOP, ...TIGHTENING_OR_DESCRIPTIVE]) {
      expect(seen.has(m.name), m.name).toBe(true);
    }
    // 5000 schema parses, refinements and classifications: about 1.5 s here, over 5 s on CI's
    // macOS runners, so it gets the budget of the other CPU-bound suites rather than bun's 5 s.
  }, 30_000);
});

describe('the review #84 probes on the bundled LinkedIn pack', () => {
  const linkedin = bundled('linkedin.com.json');
  const classify = (edit: (p: Pack) => void) => {
    const candidate = structuredClone(linkedin);
    candidate.version = (candidate.version ?? 1) + 1;
    edit(candidate);
    const parsed = SitePackV1.parse(candidate);
    expect(refinePack(parsed).issues).toEqual([]);
    return classifyPackChange(SitePackV1.parse(linkedin), parsed).classification;
  };
  const only = (c: Challenge) => (p: Pack) => {
    p.challenges = [c];
  };
  const stop = (match: Challenge['match']): Challenge => ({
    id: 'all',
    kind: 'locked',
    match,
    action: 'stop',
  });

  it.each([
    ['title_contains "LinkedIn", stop', only(stop({ title_contains: 'LinkedIn' }))],
    ['landmark "div", stop', only(stop({ landmark: 'div' }))],
    ['landmark "html > body", stop', only(stop({ landmark: 'html > body' }))],
    ['landmark "body *", stop', only(stop({ landmark: 'body *' }))],
    ['landmark "meta, div", stop', only(stop({ landmark: 'meta, div' }))],
    ['text "Home", stop', only(stop({ text: 'Home' }))],
    ['frame recaptcha, stop', only(stop({ frame: 'recaptcha' }))],
    ['url *.linkedin.com/*, stop', only(stop({ url: '*.linkedin.com/*' }))],
    [
      'guard blocking the sign-in form post',
      (p: Pack) => {
        p.guards?.push({
          id: 'submit',
          kind: 'account',
          match: { url: 'www.linkedin.com/checkpoint/lg/login-submit*', methods: ['POST'] },
          action: 'block',
        });
      },
    ],
  ] as const)('%s is restrictive (never tightening)', (_name, edit) => {
    expect(classify(edit)).toBe('restrictive');
  });
});

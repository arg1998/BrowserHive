/** @module domain/site-packs/revocation.test — revocation semantics (spec 13 §9.7): a tightening or neutral fallback applies at once, a loosening or restrictive one opens a decision, no fallback keeps and reports, for bundled and local sources. */

import { describe, expect, it } from 'bun:test';
import { NO_TEMPLATES } from './classify.ts';
import { packWith } from './classify-test-kit.ts';
import { revocationDecision } from './revocation.ts';

const revoked = packWith((p) => (p.version = 5));
/** The previous version (v4), optionally edited. */
const fallbackWith = (edit: Parameters<typeof packWith>[0]) =>
  packWith((p) => {
    p.version = 4;
    edit?.(p);
  });

describe('revocationDecision (bundled source)', () => {
  const decide = (fallback: ReturnType<typeof packWith> | null) =>
    revocationDecision({ revoked, source: 'bundled', fallback, ctx: NO_TEMPLATES });

  it('a neutral fallback applies at once', () => {
    expect(decide(fallbackWith(undefined))).toMatchObject({
      kind: 'apply_fallback',
      classification: 'neutral',
    });
  });

  it('a tightening fallback applies at once', () => {
    const d = decide(fallbackWith((p) => (p.write_policy.default = 'confirm')));
    expect(d.kind).toBe('apply_fallback');
    const tighter = decide(
      fallbackWith((p) =>
        p.guards?.push({
          id: 'x',
          kind: 'account',
          // GET only: a guard that can block a POST on the sign-in host is restrictive (D-73).
          match: { url: 'www.linkedin.com/x', methods: ['GET'] },
          action: 'block',
        }),
      ),
    );
    expect(tighter).toMatchObject({ kind: 'apply_fallback', classification: 'tightening' });
  });

  it('a loosening fallback leaves the revoked version in force and opens a decision', () => {
    const d = decide(fallbackWith((p) => (p.guards = [])));
    expect(d).toMatchObject({ kind: 'open_decision', classification: 'loosening' });
    if (d.kind === 'open_decision') {
      expect(d.changes.map((c) => c.class)).toContain('loosening');
    }
  });

  it('a restrictive fallback opens a decision', () => {
    expect(decide(fallbackWith((p) => (p.browser = { headed: 'required' })))).toMatchObject({
      kind: 'open_decision',
      classification: 'restrictive',
    });
  });

  it('no fallback keeps the revoked version and reports it', () => {
    expect(decide(null)).toEqual({ kind: 'keep_and_report', reason: 'no_fallback' });
  });

  it('remote and import sources follow the same rule', () => {
    for (const source of ['remote', 'import'] as const) {
      expect(
        revocationDecision({
          revoked,
          source,
          fallback: fallbackWith(undefined),
          ctx: NO_TEMPLATES,
        }).kind,
      ).toBe('apply_fallback');
    }
  });
});

describe('revocationDecision (local source)', () => {
  it('operator-approved local content is never replaced by a revocation, only reported', () => {
    for (const fallback of [null, fallbackWith(undefined), fallbackWith((p) => (p.guards = []))]) {
      expect(revocationDecision({ revoked, source: 'local', fallback, ctx: NO_TEMPLATES })).toEqual(
        { kind: 'keep_and_report', reason: 'operator_content' },
      );
    }
  });
});

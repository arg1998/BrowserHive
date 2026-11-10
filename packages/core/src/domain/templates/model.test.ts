/** @module domain/templates/model.test — the template gate order, sealing per principal, page caps and agent availability (spec 13 §5.1, §5.4, §6.1, §6.3). */

import { describe, expect, it } from 'bun:test';
import { templateRecord, templateSiteRecord } from '../../../test/persistence/helpers.ts';
import type { TemplateSiteRecord, TemplateUnsealRecord } from '../../ports/persistence/index.ts';
import {
  availabilityOf,
  isSessionSealed,
  isTemplateSealed,
  pageCaps,
  sealingFor,
  type TemplateHostFacts,
  templateGate,
} from './model.ts';

const SEALED: TemplateUnsealRecord = {
  cookieValues: false,
  evaluate: false,
  cookieWrites: false,
  stateExport: false,
  principals: null,
};
const idle: TemplateHostFacts = { state: 'stopped', liveAgentSessions: 0 };
const subject = { principal: 'p-agent', harness: 'claude-code', declared: null };

function site(state: TemplateSiteRecord['health']['state'], enabled = true): TemplateSiteRecord {
  return templateSiteRecord({
    siteId: `${state}-${enabled}.test`,
    enabled,
    health: { state, reason: null, checkedAt: 1, changedAt: 1, consecutiveInconclusive: 0 },
  });
}

describe('templateGate', () => {
  it('refuses a template still being recorded before looking at the caller', () => {
    expect(
      templateGate(templateRecord({ status: 'recording', authorizedPrincipals: [] }), subject),
    ).toEqual({ allowed: false, reason: 'recording' });
  });

  it('then the principal, then the harness', () => {
    expect(templateGate(templateRecord({ authorizedPrincipals: ['p-other'] }), subject)).toEqual({
      allowed: false,
      reason: 'principal_not_allowed',
    });
    expect(
      templateGate(
        templateRecord({ authorizedPrincipals: ['p-agent'], harnesses: ['opencode'] }),
        subject,
      ),
    ).toEqual({ allowed: false, reason: 'harness_not_allowed' });
    expect(
      templateGate(
        templateRecord({ authorizedPrincipals: ['p-agent'], harnesses: ['claude-code'] }),
        subject,
      ),
    ).toEqual({ allowed: true });
  });

  it('lets a disabled template through the gate (its launch answers TEMPLATE_DISABLED)', () => {
    expect(templateGate(templateRecord({ status: 'disabled' }), subject)).toEqual({
      allowed: true,
    });
  });
});

describe('sealing', () => {
  it('everything is sealed by default', () => {
    const s = sealingFor(SEALED, 'p-agent');
    expect(s).toEqual({
      hideCookieValues: true,
      forceDisableEvaluate: true,
      refuseCookieWrites: true,
      refuseStateExport: true,
    });
    expect(isSessionSealed(s)).toBe(true);
    expect(isTemplateSealed(SEALED)).toBe(true);
  });

  it('each flag relaxes exactly its behaviour, for every principal', () => {
    for (const [flag, field] of [
      ['cookieValues', 'hideCookieValues'],
      ['evaluate', 'forceDisableEvaluate'],
      ['cookieWrites', 'refuseCookieWrites'],
      ['stateExport', 'refuseStateExport'],
    ] as const) {
      const s = sealingFor({ ...SEALED, [flag]: true }, 'anyone');
      for (const key of Object.keys(s) as (keyof typeof s)[]) {
        expect(s[key]).toBe(key !== field);
      }
      expect(isTemplateSealed({ ...SEALED, [flag]: true })).toBe(false);
    }
  });

  it('a principal list limits the unsealing to those principals', () => {
    const unseal = { ...SEALED, evaluate: true, principals: ['p-trusted'] };
    expect(sealingFor(unseal, 'p-trusted').forceDisableEvaluate).toBe(false);
    expect(sealingFor(unseal, 'p-other').forceDisableEvaluate).toBe(true);
    expect(sealingFor({ ...unseal, principals: [] }, 'p-other').forceDisableEvaluate).toBe(false);
  });

  it('a session is unsealed only when no protection is left', () => {
    const all = {
      cookieValues: true,
      evaluate: true,
      cookieWrites: true,
      stateExport: true,
      principals: null,
    };
    expect(isSessionSealed(sealingFor(all, 'x'))).toBe(false);
    expect(isSessionSealed(sealingFor({ ...all, stateExport: false }, 'x'))).toBe(true);
  });
});

describe('pageCaps', () => {
  it('splits the host pages over the cap with a floor of two per session', () => {
    expect(pageCaps(40, 5)).toEqual({ host: 40, perSession: 8 });
    expect(pageCaps(40, 20)).toEqual({ host: 40, perSession: 2 });
    expect(pageCaps(2, 20)).toEqual({ host: 2, perSession: 2 });
    expect(pageCaps(41, 4)).toEqual({ host: 41, perSession: 10 });
  });
});

describe('availabilityOf', () => {
  const ready = templateRecord({ maxConcurrent: 2 });

  it('a stopped browser counts as available', () => {
    expect(availabilityOf(ready, [site('signed_in')], idle)).toBe('available');
  });

  it('is unavailable when not ready or when the browser needs the operator', () => {
    expect(availabilityOf(templateRecord({ status: 'disabled' }), [], idle)).toBe('unavailable');
    expect(availabilityOf(ready, [], { state: 'failed', liveAgentSessions: 0 })).toBe(
      'unavailable',
    );
  });

  it('needs a login when every enabled site is signed out or challenged', () => {
    expect(availabilityOf(ready, [site('signed_out'), site('challenged')], idle)).toBe(
      'needs_login',
    );
    expect(availabilityOf(ready, [site('signed_out'), site('signed_in', false)], idle)).toBe(
      'needs_login',
    );
    expect(availabilityOf(ready, [site('signed_out'), site('unknown')], idle)).toBe('available');
    expect(availabilityOf(ready, [site('signed_out', false)], idle)).toBe('available');
  });

  it('is busy at the cap or while the browser is draining or recovering', () => {
    expect(availabilityOf(ready, [], { state: 'running', liveAgentSessions: 2 })).toBe('busy');
    expect(availabilityOf(ready, [], { state: 'running', liveAgentSessions: 1 })).toBe('available');
    expect(availabilityOf(ready, [], { state: 'draining', liveAgentSessions: 0 })).toBe('busy');
    expect(availabilityOf(ready, [], { state: 'crashed', liveAgentSessions: 0 })).toBe('busy');
  });
});

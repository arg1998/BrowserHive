/** @module app/templates/host-state.test — backoff, the failure window, permanent failures, idle and recycle clocks, and TemplateAdmission's order and codes. */

import { describe, expect, it } from 'bun:test';
import { ERROR_REGISTRY } from '@browserhive/contracts/errors';
import { AppError, isAppError } from '../../kernel/errors/app-error.ts';
import {
  FAILURE_WINDOW_MS,
  FailureWindow,
  holdsSlot,
  idleExpired,
  nextIdleSince,
  permanentFailure,
  RESTART_BACKOFF_MS,
  recycleAt,
} from './host-state.ts';
import { type AdmissionFacts, admitNewPage, admitTemplateLaunch } from './template-admission.ts';

function refusal(run: () => void): { code: string; details: unknown; message: string } | null {
  try {
    run();
    return null;
  } catch (err) {
    if (!isAppError(err)) throw err;
    return { code: err.code, details: err.details, message: err.publicMessage };
  }
}

const FACTS: AdmissionFacts = {
  name: 'job-hunt',
  state: 'running',
  retryAfterMs: null,
  agentSessions: 0,
  cap: 2,
  agentPages: 0,
  caps: { host: 4, perSession: 2 },
};

describe('host state rules', () => {
  it('backs off 5 s, 15 s, 45 s, 135 s, 405 s and stays at the last step', () => {
    expect([1, 2, 3, 4, 5, 9].map(FailureWindow.backoff)).toEqual([...RESTART_BACKOFF_MS, 405_000]);
  });

  it('counts failures inside the 30-minute window only', () => {
    const window = new FailureWindow();
    expect(window.record(0)).toBe(1);
    expect(window.record(1_000)).toBe(2);
    expect(window.record(FAILURE_WINDOW_MS + 500)).toBe(2);
    window.clear();
    expect(window.record(FAILURE_WINDOW_MS + 600)).toBe(1);
  });

  it('classifies display, proxy and sandbox failures as permanent', () => {
    expect(permanentFailure(new AppError('INTERNAL_ERROR', { ref: 'no_display' }))).toBe(
      'no_display',
    );
    expect(permanentFailure(new AppError('INTERNAL_ERROR', { ref: 'proxy_unreachable' }))).toBe(
      'proxy_unreachable',
    );
    expect(permanentFailure(new AppError('INTERNAL_ERROR', { ref: 'browser-launch' }))).toBeNull();
    expect(permanentFailure(new Error('boom'))).toBeNull();
  });

  it('starting, running and draining hosts hold a browser slot', () => {
    expect(
      ['stopped', 'starting', 'running', 'draining', 'crashed', 'failed'].map((s) =>
        holdsSlot(s as never),
      ),
    ).toEqual([false, true, true, true, false, false]);
  });

  it('idles from the first unused tick; 0 never stops; recycle is start + age', () => {
    expect(nextIdleSince(null, false, 10)).toBe(10);
    expect(nextIdleSince(10, false, 20)).toBe(10);
    expect(nextIdleSince(10, true, 20)).toBeNull();
    expect(idleExpired(10, 100, 110)).toBe(true);
    expect(idleExpired(10, 0, 1e12)).toBe(false);
    expect(recycleAt(1_000, 500)).toBe(1_500);
    expect(recycleAt(1_000, 0)).toBeNull();
    expect(recycleAt(null, 500)).toBeNull();
  });
});

describe('TemplateAdmission', () => {
  it('answers by host state first: draining, crashed, failed', () => {
    expect(refusal(() => admitTemplateLaunch({ ...FACTS, state: 'draining' }))).toMatchObject({
      code: 'TEMPLATE_UNAVAILABLE',
      details: { template: 'job-hunt', reason: 'restarting', retry_after_ms: 5_000 },
    });
    expect(
      refusal(() => admitTemplateLaunch({ ...FACTS, state: 'crashed', retryAfterMs: 12_345 })),
    ).toMatchObject({ details: { reason: 'recovering', retry_after_ms: 12_345 } });
    expect(
      refusal(() => admitTemplateLaunch({ ...FACTS, state: 'failed', agentSessions: 9 })),
    ).toMatchObject({ code: 'TEMPLATE_DISABLED', details: { reason: 'needs_operator' } });
  });

  it('then the template cap and the host page cap, with the registry text', () => {
    const busy = refusal(() => admitTemplateLaunch({ ...FACTS, agentSessions: 2 }));
    expect(busy).toMatchObject({
      code: 'TEMPLATE_BUSY',
      details: {
        limit_kind: 'capacity',
        limit_text: "Template 'job-hunt' is at capacity.",
        retry_after_s: 5,
      },
    });
    expect(busy?.message).toBe("Template 'job-hunt' is at capacity. Retry in 5 s.");
    expect(refusal(() => admitTemplateLaunch({ ...FACTS, agentPages: 4 }))?.code).toBe(
      'TEMPLATE_BUSY',
    );
    expect(refusal(() => admitTemplateLaunch({ ...FACTS, state: 'stopped' }))).toBeNull();
    expect(ERROR_REGISTRY.TEMPLATE_BUSY.retryable).toBe('backoff');
  });

  it('new_tab checks the host cap, then the session cap', () => {
    expect(refusal(() => admitNewPage('t', { host: 4, perSession: 2 }, 4, 0))).toMatchObject({
      details: { limit_kind: 'capacity' },
    });
    expect(refusal(() => admitNewPage('t', { host: 4, perSession: 2 }, 3, 2))).toMatchObject({
      details: {
        limit_kind: 'tabs',
        limit_text: 'This session has reached its tab limit; close a tab you no longer need.',
      },
    });
    expect(refusal(() => admitNewPage('t', { host: 4, perSession: 2 }, 3, 1))).toBeNull();
  });
});

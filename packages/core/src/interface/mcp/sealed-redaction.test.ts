/** @module interface/mcp/sealed-redaction.test — the dispatcher's cookie-value redaction for sealed template sessions (spec 13 §5.4): fresh jar per result, remembered rotated values, a jar that cannot be read, and sessions it never touches. */
import { describe, expect, it } from 'bun:test';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { fakeCookie } from '../../../test/helpers/fake-template-host.ts';
import { NO_SEALING, type SessionTemplate } from '../../domain/session/session-template.ts';
import type { Cookie } from '../../ports/browser-driver.ts';
import { SEALED_VALUE_MEMORY_MS, SealedRedaction } from './sealed-redaction.ts';

const SEALED = {
  hideCookieValues: true,
  forceDisableEvaluate: true,
  refuseCookieWrites: true,
  refuseStateExport: true,
};

function template(sealing = SEALED): SessionTemplate {
  return {
    templateId: 'tp-fixture001',
    name: 'job-hunt',
    version: null,
    mode: 'live',
    sealed: true,
    sealing,
    sites: [],
  };
}

function session(jar: { cookies: Cookie[] | null }, sealing = SEALED) {
  return {
    template: template(sealing),
    view: {
      cookies: async () => {
        if (jar.cookies === null) throw new Error('browser closed');
        return jar.cookies;
      },
    },
  } as never;
}

describe('SealedRedaction', () => {
  it('redacts every value in the jar now, and remembers rotated values for a while', async () => {
    const clock = new FakeClock();
    const redaction = new SealedRedaction(clock);
    const jar = { cookies: [fakeCookie('site-a.test', 'sid', 'first-token-0123456789')] };
    const s = session(jar);
    expect((await redaction.scrubberFor(s))?.('a first-token-0123456789 b')).toBe('a [sealed] b');
    jar.cookies = [fakeCookie('site-a.test', 'sid', 'second-token-0123456789')];
    const scrub = await redaction.scrubberFor(s);
    expect(scrub?.('first-token-0123456789 second-token-0123456789')).toBe('[sealed] [sealed]');
    await clock.advance(SEALED_VALUE_MEMORY_MS + 1);
    expect((await redaction.scrubberFor(s))?.('first-token-0123456789')).toBe(
      'first-token-0123456789',
    );
  });

  it('keeps the known values when the jar cannot be read', async () => {
    const redaction = new SealedRedaction(new FakeClock());
    const jar: { cookies: Cookie[] | null } = {
      cookies: [fakeCookie('site-a.test', 'sid', 'known-token-0123456789')],
    };
    await redaction.scrubberFor(session(jar));
    jar.cookies = null;
    expect((await redaction.scrubberFor(session(jar)))?.('known-token-0123456789')).toBe(
      '[sealed]',
    );
  });

  it('leaves exclusive sessions, maintenance sessions and unsealed cookie values alone', async () => {
    const redaction = new SealedRedaction(new FakeClock());
    expect(await redaction.scrubberFor(null)).toBeNull();
    expect(await redaction.scrubberFor({ template: null, view: null } as never)).toBeNull();
    expect(await redaction.scrubberFor(session({ cookies: [] }, NO_SEALING))).toBeNull();
  });
});

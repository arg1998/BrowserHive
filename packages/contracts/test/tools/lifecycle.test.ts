/** @module contracts/test/tools/lifecycle.test — launch_session defaults, slug rule and server-derived defaults */
/// <reference types="bun-types" />
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import {
  LAUNCH_SESSION,
  LIST_SESSIONS,
  launchSessionInput,
  SLUG_RE,
} from '../../src/tools/lifecycle.ts';

describe('launch_session input', () => {
  it('applies the defaults and leaves optional flags absent', () => {
    expect(LAUNCH_SESSION.input.parse({ slug: 'demo' })).toEqual({
      slug: 'demo',
      channel: 'chromium',
      incognito: false,
      headless: true,
      disable_evaluate: false,
      vault_enabled: true,
    });
  });

  it('validates the slug with the stable message', () => {
    for (const bad of ['A', 'a', '1abc', '-abc', 'a_b', 'a'.repeat(33), 'ab c']) {
      const result = LAUNCH_SESSION.input.safeParse({ slug: bad });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe('slug must match /^[a-z][a-z0-9-]{1,31}$/');
      }
    }
    for (const good of ['ab', 'a1', 'my-session-2', 'a'.repeat(32)]) {
      expect(SLUG_RE.test(good)).toBe(true);
    }
  });

  it('passes launch/context options through loosely and types the known keys', () => {
    const parsed = LAUNCH_SESSION.input.parse({
      slug: 'demo',
      launch_options: { args: ['--foo'], executablePath: '/x', slowMo: 10 },
      context_options: { storageState: 'saved', locale: 'en-US' },
    });
    expect(parsed.launch_options).toEqual({ args: ['--foo'], executablePath: '/x', slowMo: 10 });
    expect(parsed.context_options).toEqual({ storageState: 'saved', locale: 'en-US' });
    expect(
      LAUNCH_SESSION.input.safeParse({ slug: 'demo', launch_options: { args: 'x' } }).success,
    ).toBe(false);
  });

  it('rejects unknown channels and persistence modes', () => {
    expect(LAUNCH_SESSION.input.safeParse({ slug: 'demo', channel: 'firefox' }).success).toBe(
      false,
    );
    expect(LAUNCH_SESSION.input.safeParse({ slug: 'demo', persistence_mode: 'disk' }).success).toBe(
      false,
    );
  });

  it('bakes server-derived defaults into the advertised schema', () => {
    const input = launchSessionInput({ channel: 'edge', headless: false });
    expect(input.parse({ slug: 'demo' })).toMatchObject({ channel: 'edge', headless: false });
    const json = z.toJSONSchema(input, { target: 'draft-07', io: 'input' });
    const props = json['properties'] ?? {};
    expect(props['channel']).toMatchObject({ default: 'edge' });
    expect(props['headless']).toMatchObject({ default: false });
  });
});

describe('list_sessions', () => {
  it('has no input schema (takes no arguments)', () => {
    expect('input' in LIST_SESSIONS).toBe(false);
  });
});

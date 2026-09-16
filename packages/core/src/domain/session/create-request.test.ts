/** @module domain/session/create-request.test — defaults, stealth collapse, persistence rules and typed errors of validateCreateRequest. */

import { describe, expect, it } from 'bun:test';
import { isAppError } from '../../kernel/errors/app-error.ts';
import {
  type CreateSessionInput,
  createSessionInputFromWire,
  type SessionDefaults,
  sessionDefaultsFromConfig,
  validateCreateRequest,
} from './create-request.ts';
import { LOCAL_PRINCIPAL } from './principal.ts';

const defaults: SessionDefaults = {
  headless: true,
  channel: 'chromium',
  persistence: 'memory',
  stealth: true,
  fingerprint: true,
  humanize: false,
};

function validate(input: CreateSessionInput, d: SessionDefaults = defaults) {
  return validateCreateRequest(input, d, LOCAL_PRINCIPAL);
}

function expectCode(fn: () => unknown, code: string): { message: string; details: unknown } {
  try {
    fn();
  } catch (err) {
    expect(isAppError(err)).toBe(true);
    if (!isAppError(err)) throw err;
    expect<string>(err.code).toBe(code);
    return { message: err.message, details: err.details };
  }
  throw new Error(`expected ${code}`);
}

describe('validateCreateRequest — defaults', () => {
  it('applies server defaults and the default launch flags', () => {
    const r = validate({ slug: 'shop' });
    expect(r).toMatchObject({
      slug: 'shop',
      channel: 'chromium',
      incognito: false,
      headless: true,
      persistenceMode: 'memory',
      restoreProfile: null,
      storageStateName: null,
      launchOptions: undefined,
      contextOptions: undefined,
      disableEvaluate: false,
      vaultEnabled: true,
      stealth: true,
      fingerprint: true,
      humanize: false,
      owner: 'local',
      tenantId: null,
      connectionId: null,
    });
  });

  it('honours defaultHeadless/defaultChannel/persistence from config', () => {
    const d = sessionDefaultsFromConfig({
      defaultHeadless: false,
      defaultChannel: 'edge',
      persistence: 'storage-state',
      stealth: 'off',
      fingerprint: false,
      humanize: false,
    });
    const r = validate({ slug: 'shop' }, d);
    expect(r.headless).toBe(false);
    expect(r.channel).toBe('edge');
    expect(r.persistenceMode).toBe('storage-state');
    expect(r.stealth).toBe(false);
  });

  it('per-session values override the defaults', () => {
    const r = validate({
      slug: 'shop',
      headless: false,
      channel: 'chrome',
      persistenceMode: 'persistent',
    });
    expect(r.headless).toBe(false);
    expect(r.channel).toBe('chrome');
    expect(r.persistenceMode).toBe('persistent');
  });

  it('stamps owner and tenant from the principal', () => {
    const r = validateCreateRequest({ slug: 'shop', connectionId: 'c-1' }, defaults, {
      subject: 'alice',
      tenantId: 't-1',
    });
    expect(r.owner).toBe('alice');
    expect(r.tenantId).toBe('t-1');
    expect(r.connectionId).toBe('c-1');
  });
});

describe('validateCreateRequest — stealth collapse', () => {
  it('fingerprint and humanize collapse to false when stealth is off', () => {
    const r = validate({ slug: 'shop', stealth: false, fingerprint: true, humanize: true });
    expect(r.stealth).toBe(false);
    expect(r.fingerprint).toBe(false);
    expect(r.humanize).toBe(false);
  });

  it('per-session stealth wins over the default; fingerprint/humanize follow request then default', () => {
    const r = validate(
      { slug: 'shop', stealth: true, humanize: true },
      { ...defaults, stealth: false },
    );
    expect(r.stealth).toBe(true);
    expect(r.fingerprint).toBe(true);
    expect(r.humanize).toBe(true);
    const r2 = validate({ slug: 'shop', fingerprint: false });
    expect(r2.fingerprint).toBe(false);
  });
});

describe('validateCreateRequest — typed errors', () => {
  it('INVALID_SLUG', () => {
    const { message } = expectCode(() => validate({ slug: 'Bad' }), 'INVALID_SLUG');
    expect(message).toStartWith("Invalid slug 'Bad'. Slugs must match");
  });

  it('UNKNOWN_CHANNEL', () => {
    const { message, details } = expectCode(
      () => validate({ slug: 'shop', channel: 'firefox' }),
      'UNKNOWN_CHANNEL',
    );
    expect(message).toBe(
      "Unknown browser channel 'firefox'. Expected one of: chromium, chrome, edge.",
    );
    expect(details).toEqual({ channel: 'firefox', supported: ['chromium', 'chrome', 'edge'] });
  });

  it('INVALID_PERSISTENCE_CONFIG texts exactly', () => {
    const cases: Array<[CreateSessionInput, string]> = [
      [
        { slug: 'shop', persistenceMode: 'blueprint' },
        "Invalid persistence config: unknown persistence mode 'blueprint'; expected one of memory, persistent, storage-state",
      ],
      [
        { slug: 'shop', persistenceMode: 'persistent', launchOptions: { userDataDir: '/tmp/x' } },
        'Invalid persistence config: userDataDir cannot be supplied in persistent mode; the managed profile path is used',
      ],
      [
        { slug: 'shop', persistenceMode: 'persistent', contextOptions: { storageState: 'saved' } },
        'Invalid persistence config: restoring storage state requires a non-persistent mode',
      ],
      [
        { slug: 'shop', persistenceMode: 'memory', restoreProfile: 'saved' },
        'Invalid persistence config: restoring a profile requires persistent mode',
      ],
      [
        { slug: 'shop', persistenceMode: 'persistent', incognito: true },
        'Invalid persistence config: incognito is incompatible with persistent mode, which writes a profile to disk; use memory or storage-state mode for an ephemeral session',
      ],
    ];
    for (const [input, text] of cases) {
      const { message } = expectCode(() => validate(input), 'INVALID_PERSISTENCE_CONFIG');
      expect(message).toBe(text);
    }
  });

  it('UNSAFE_LAUNCH_ARG for a deny-listed arg and for unsafe sibling fields', () => {
    const { message } = expectCode(
      () => validate({ slug: 'shop', launchOptions: { args: ['--foo', '--no-sandbox'] } }),
      'UNSAFE_LAUNCH_ARG',
    );
    expect(message).toBe(
      "Launch arg '--no-sandbox' is on the deny-list and would break session isolation.",
    );
    for (const field of ['env', 'downloadsPath', 'recordVideo']) {
      const launchOptions: Record<string, unknown> = { [field]: {} };
      const { details } = expectCode(
        () => validate({ slug: 'shop', launchOptions }),
        'UNSAFE_LAUNCH_ARG',
      );
      expect(details).toEqual({ arg: field });
    }
    const { details } = expectCode(
      () => validate({ slug: 'shop', launchOptions: { chromiumSandbox: false } }),
      'UNSAFE_LAUNCH_ARG',
    );
    expect(details).toEqual({ arg: 'chromiumSandbox' });
    expect(() =>
      validate({ slug: 'shop', launchOptions: { chromiumSandbox: true } }),
    ).not.toThrow();
  });

  it('extracts a string storageState as the saved-auth name and passes objects through', () => {
    const named = validate({ slug: 'shop', contextOptions: { storageState: 'github' } });
    expect(named.storageStateName).toBe('github');
    const inline = validate({ slug: 'shop', contextOptions: { storageState: { cookies: [] } } });
    expect(inline.storageStateName).toBeNull();
    expect<unknown>(inline.contextOptions).toEqual({ storageState: { cookies: [] } });
  });

  it('forwards unknown launch/context keys verbatim', () => {
    const r = validate({
      slug: 'shop',
      launchOptions: { args: ['--foo'], slowMo: 5 },
      contextOptions: { viewport: { width: 1, height: 2 }, locale: 'de-DE' },
    });
    expect(r.launchOptions).toEqual({ args: ['--foo'], slowMo: 5 });
    expect(r.contextOptions).toEqual({ viewport: { width: 1, height: 2 }, locale: 'de-DE' });
  });
});

describe('createSessionInputFromWire', () => {
  it('maps every snake_case key and keeps absent keys absent', () => {
    const mapped = createSessionInputFromWire(
      {
        slug: 'shop',
        channel: 'chrome',
        incognito: true,
        headless: false,
        persistence_mode: 'persistent',
        restore_profile: 'p',
        launch_options: { args: [] },
        context_options: { locale: 'en' },
        disable_evaluate: true,
        vault_enabled: false,
        stealth: true,
        fingerprint: false,
        humanize: true,
      },
      'c-1',
    );
    expect(mapped).toEqual({
      slug: 'shop',
      channel: 'chrome',
      incognito: true,
      headless: false,
      persistenceMode: 'persistent',
      restoreProfile: 'p',
      launchOptions: { args: [] },
      contextOptions: { locale: 'en' },
      disableEvaluate: true,
      vaultEnabled: false,
      stealth: true,
      fingerprint: false,
      humanize: true,
      connectionId: 'c-1',
    });
    expect(createSessionInputFromWire({ slug: 'shop' })).toEqual({
      slug: 'shop',
      connectionId: null,
    });
  });
});

/** @module domain/templates/launch-options.test — the option table of spec 13 §5.3: the five schema-defaulted parameters pass, every fixed option is refused by presence with one issue naming it. */

import { describe, expect, it } from 'bun:test';
import { PER_SESSION_TEMPLATE_CONTEXT_OPTIONS } from '@browserhive/contracts/tools';
import { templateRecord } from '../../../test/persistence/helpers.ts';
import type { CreateSessionInput } from '../session/create-request.ts';
import {
  applyTemplateLaunchOptions,
  fixedOptionMessage,
  PER_SESSION_CONTEXT_OPTIONS,
} from './launch-options.ts';
import { type SessionSealing, sealingFor } from './model.ts';

const template = templateRecord({ stealth: 'standard', fingerprint: false, humanize: false });
const sealed: SessionSealing = sealingFor(template.unseal, 'p-agent');
const unsealedEvaluate: SessionSealing = { ...sealed, forceDisableEvaluate: false };

/** What `launch_session` always sends: the schema bakes defaults into these five. */
const DEFAULTED: CreateSessionInput = {
  slug: 'jobs',
  channel: 'chrome',
  incognito: true,
  headless: true,
  disableEvaluate: false,
  vaultEnabled: true,
};

describe('applyTemplateLaunchOptions', () => {
  it('mirrors the contracts list of per-session context options', () => {
    expect([...PER_SESSION_CONTEXT_OPTIONS]).toEqual([...PER_SESSION_TEMPLATE_CONTEXT_OPTIONS]);
  });

  it('passes the five schema-defaulted parameters whatever their values', () => {
    for (const input of [
      DEFAULTED,
      { ...DEFAULTED, channel: 'edge', incognito: false, headless: false, vaultEnabled: false },
    ]) {
      const result = applyTemplateLaunchOptions(template, input, unsealedEvaluate);
      expect(result).toEqual({
        ok: true,
        settings: { disableEvaluate: false, humanize: false, contextOptions: {} },
      });
    }
  });

  it('forces disable_evaluate while evaluate is sealed and applies it as sent otherwise', () => {
    const forced = applyTemplateLaunchOptions(template, DEFAULTED, sealed);
    expect(forced.ok && forced.settings.disableEvaluate).toBe(true);
    const asSent = applyTemplateLaunchOptions(
      template,
      { ...DEFAULTED, disableEvaluate: true },
      unsealedEvaluate,
    );
    expect(asSent.ok && asSent.settings.disableEvaluate).toBe(true);
  });

  it('applies humanize, collapsing it with the template stealth off', () => {
    const on = applyTemplateLaunchOptions(template, { ...DEFAULTED, humanize: true }, sealed);
    expect(on.ok && on.settings.humanize).toBe(true);
    const off = applyTemplateLaunchOptions(
      templateRecord({ stealth: 'off' }),
      { ...DEFAULTED, humanize: true, stealth: false },
      sealed,
    );
    expect(off.ok && off.settings.humanize).toBe(false);
  });

  it('accepts stealth and fingerprint equal to the template and memory persistence', () => {
    const result = applyTemplateLaunchOptions(
      template,
      { ...DEFAULTED, stealth: true, fingerprint: false, persistenceMode: 'memory' },
      sealed,
    );
    expect(result.ok).toBe(true);
  });

  it('keeps the per-session context options and an empty launch_options', () => {
    const viewport = { width: 800, height: 600 };
    const result = applyTemplateLaunchOptions(
      template,
      {
        ...DEFAULTED,
        launchOptions: {},
        contextOptions: { viewport, extraHTTPHeaders: { 'x-a': '1' }, colorScheme: 'dark' },
      },
      sealed,
    );
    expect(result).toEqual({
      ok: true,
      settings: {
        disableEvaluate: true,
        humanize: false,
        contextOptions: { viewport, extraHTTPHeaders: { 'x-a': '1' }, colorScheme: 'dark' },
      },
    });
  });

  it('refuses every fixed option by presence, one issue each, naming it', () => {
    const result = applyTemplateLaunchOptions(
      template,
      {
        ...DEFAULTED,
        stealth: false,
        fingerprint: true,
        persistenceMode: 'persistent',
        restoreProfile: 'old',
        launchOptions: { args: [], proxy: { server: 'http://x:1' } },
        contextOptions: { locale: 'en-CA', viewport: null, geolocation: { latitude: 1 } },
      },
      sealed,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => i.path)).toEqual([
      'stealth',
      'fingerprint',
      'persistence_mode',
      'restore_profile',
      'launch_options.args',
      'launch_options.proxy',
      'context_options.locale',
      'context_options.geolocation',
    ]);
    expect(result.issues[6]?.message).toBe(
      "template 'job-hunt' fixes context_options.locale; omit it",
    );
  });

  it('refuses storage-state persistence and a context option even when its value matches', () => {
    const result = applyTemplateLaunchOptions(
      template,
      {
        ...DEFAULTED,
        persistenceMode: 'storage-state',
        contextOptions: { locale: template.identity.locale },
      },
      sealed,
    );
    expect(result.ok ? [] : result.issues.map((i) => i.path)).toEqual([
      'persistence_mode',
      'context_options.locale',
    ]);
  });

  it('words the refusal as spec 13 §5.3 does', () => {
    expect(fixedOptionMessage('job-hunt', 'launch_options.args')).toBe(
      "template 'job-hunt' fixes launch_options.args; omit it",
    );
  });
});

/** @module features/templates/relogin-text.test — the words of T2 (spec 13 §8): health reasons, re-login failures, a binding's problems read from the binding (open principals, template not listed, harness lists; session names don't count), who asked for a re-login, the couldn't-tell threshold and whether a page's host is on the template's sites */
import { describe, expect, it } from 'bun:test';
import type { VaultBinding } from '@browserhive/contracts/http';
import { bindingRow } from '@/features/vault/fixtures.ts';
import { templateSite, tid } from '../../../test/fixtures/templates.ts';
import { healthReasonText, hostOnSites, inconclusiveWarning } from './model.ts';
import {
  bindingProblemsOf,
  reloginActive,
  reloginErrorText,
  requesterText,
} from './relogin-text.ts';

const ID = tid(1);
const binding = (patch: Record<string, unknown>) => bindingRow(patch) as unknown as VaultBinding;

describe('health and re-login words', () => {
  it('words every T2 reason', () => {
    for (const code of [
      'learned_cookies',
      'cookies_absent',
      'partial_cookies',
      'no_pack',
      'not_running',
      'confirmed_by_operator',
      'not_confirmed',
      'relogin',
    ])
      expect(healthReasonText(code)).not.toContain('_');
    expect(healthReasonText('not_running')).toBe('Couldn’t check: the browser isn’t running.');
    expect(healthReasonText('http_502')).toBe('http 502.');
    expect(healthReasonText(null)).toBeNull();
  });

  it('words every re-login error', () => {
    for (const code of [
      'fill_failed',
      'not_authorized',
      'still_signed_out',
      'timed_out',
      'window_closed',
      'retry_window',
    ])
      expect(reloginErrorText(code, 'failed')).not.toContain('_');
    expect(reloginErrorText(null, 'timed_out')).toContain('30 minutes');
  });

  it('knows which re-logins are still going', () => {
    expect(reloginActive(null)).toBe(false);
  });

  it('warns from the third inconclusive check on', () => {
    const site = (n: number) =>
      templateSite('linkedin.com', {
        title: 'LinkedIn',
        health: {
          state: 'inconclusive',
          checked_at: 1,
          changed_at: 1,
          reason: 'partial_cookies',
          consecutive_inconclusive: n,
        },
      });
    expect(inconclusiveWarning(site(2))).toBeNull();
    expect(inconclusiveWarning(site(3))).toBe(
      'BrowserHive couldn’t tell whether LinkedIn is signed in',
    );
  });

  it('matches a page host to the template’s sites (subdomains included, look-alikes not)', () => {
    const sites = ['linkedin.com', 'indeed.com'];
    expect(hostOnSites('www.linkedin.com', sites)).toBe(true);
    expect(hostOnSites('linkedin.com.', sites)).toBe(true);
    expect(hostOnSites('linkedin.com.evil.test', sites)).toBe(false);
    expect(hostOnSites('evil-linkedin.com', sites)).toBe(false);
  });
});

describe('requesterText', () => {
  it('names a notification button’s presser by platform, an operator by name', () => {
    expect(requesterText('telegram:1180442')).toBe('from Telegram (user 1180442)');
    expect(requesterText('discord:99')).toBe('from Discord (user 99)');
    expect(requesterText('slack:U1')).toBe('from Slack (user U1)');
    expect(requesterText('admin')).toBe('by admin');
    expect(requesterText('token:abc')).toBe('by token:abc');
  });
});

describe('bindingProblemsOf', () => {
  it('a missing binding is not found', () => {
    expect(bindingProblemsOf(undefined, ID)).toEqual(['binding_not_found']);
  });

  it('open principals and a harness list are each a problem; session names are not (M-1)', () => {
    expect(bindingProblemsOf(binding({ harnesses: ['claude-code'] }), ID)).toEqual([
      'principals_open',
      'harness_list',
    ]);
  });

  it('a binding listing the template has none, whatever session names it allows', () => {
    expect(
      bindingProblemsOf(
        binding({
          authorized_principals: [`template:${ID}`],
          authorized_session_slugs: ['jobs-*'],
        }),
        ID,
      ),
    ).toEqual([]);
    expect(
      bindingProblemsOf(
        binding({ authorized_principals: ['operator'], allow_all_sessions: true }),
        ID,
      ),
    ).toEqual(['principal_not_listed']);
  });
});

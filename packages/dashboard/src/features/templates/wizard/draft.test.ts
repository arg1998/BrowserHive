/** @module features/templates/wizard/draft.test — the wizard's draft rules: per-step problems (name grammar, sites, proxy and its explicit language and time zone, access under auth=token), adding sites as typed, the `POST /templates` body, server issues mapped to steps; and the sign-in step's error states */
import { describe, expect, it } from 'bun:test';
import { AppError } from '@/lib/api/errors.ts';
import { hostView, template } from '../../../../test/fixtures/templates.ts';
import { hostOf, nameProblem, remoteHost, suggestName } from '../model.ts';
import {
  addSite,
  EMPTY_DRAFT,
  firstProblemStep,
  issuesOf,
  stepOfIssue,
  stepProblems,
  type TemplateDraft,
  toTemplateInput,
} from './draft.ts';
import { recordingSessionOf, signInProblem } from './sign-in-model.ts';

const READY: TemplateDraft = { ...EMPTY_DRAFT, name: 'job-hunt', sites: ['linkedin.com'] };

describe('names and sites', () => {
  it('checks the agent-facing name grammar and suggests one from the display name', () => {
    expect(nameProblem('')).toContain('name');
    expect(nameProblem('a')).toBe('At least 2 characters.');
    expect(nameProblem('9lives')).toBe('Start with a lowercase letter.');
    expect(nameProblem('Job_hunt')).not.toBeNull();
    expect(nameProblem('job-hunt')).toBeNull();
    expect(suggestName('Job hunt (CA) ')).toBe('job-hunt-ca');
    expect(suggestName('42')).toBe('');
  });

  it('keeps only the host of what was typed and refuses duplicates', () => {
    expect(hostOf('https://www.LinkedIn.com/jobs?x=1')).toBe('linkedin.com');
    expect(hostOf('indeed.com')).toBe('indeed.com');
    expect(hostOf('not a domain')).toBeNull();
    expect(hostOf('localhost')).toBeNull();
    const once = addSite(EMPTY_DRAFT, 'linkedin.com');
    expect(once.error).toBeNull();
    expect(addSite(once.draft, 'www.linkedin.com').error).toContain('already');
  });

  it('knows a loopback address from another machine', () => {
    expect(remoteHost({ hostname: '127.0.0.1' })).toBeNull();
    expect(remoteHost({ hostname: 'localhost' })).toBeNull();
    expect(remoteHost({ hostname: '[::1]' })).toBeNull();
    expect(remoteHost({ hostname: 'hive.lan' })).toBe('hive.lan');
  });
});

describe('step problems', () => {
  it('needs a name and a site before going on', () => {
    expect(stepProblems(EMPTY_DRAFT, 1, false).map((p) => p.field)).toEqual(['name']);
    expect(stepProblems(EMPTY_DRAFT, 2, false).map((p) => p.field)).toEqual(['sites']);
    expect(firstProblemStep(EMPTY_DRAFT, false)).toBe(1);
    expect(firstProblemStep(READY, false)).toBeNull();
  });

  it('refuses a proxy with credentials or a BROWSERHIVE_ variable and wants language and zone with it', () => {
    const proxy = (server: string, passwordEnv = '') => ({
      ...READY,
      useProxy: true,
      proxy: { ...READY.proxy, server, passwordEnv },
    });
    const fields = (d: TemplateDraft) => stepProblems(d, 3, false).map((p) => p.field);
    expect(fields(proxy('http://user:pw@10.0.0.5:3128'))).toContain('proxy.server');
    expect(fields(proxy('10.0.0.5:3128'))).toContain('proxy.server');
    expect(fields(proxy('http://10.0.0.5:3128', 'BROWSERHIVE_PW'))).toContain('proxy.passwordEnv');
    expect(fields(proxy('socks5://10.0.0.5:1080'))).toEqual(['locale', 'timezoneId']);
    expect(
      fields({ ...proxy('http://10.0.0.5:3128'), locale: 'en-CA', timezoneId: 'America/Toronto' }),
    ).toEqual([]);
  });

  it('wants an explicit access choice under auth=token only', () => {
    expect(stepProblems(READY, 4, true).map((p) => p.field)).toEqual(['access']);
    expect(stepProblems(READY, 4, false)).toEqual([]);
    expect(stepProblems({ ...READY, access: 'listed' }, 4, true).map((p) => p.field)).toEqual([
      'principals',
    ]);
  });
});

describe('the POST /templates body', () => {
  it('sends only what the operator set', () => {
    expect(toTemplateInput(READY)).toEqual({
      name: 'job-hunt',
      sites: [{ site_id: 'linkedin.com' }],
      policy: { max_concurrent: 5 },
    });
  });

  it('carries the proxy, access, harnesses and unseal flags', () => {
    const body = toTemplateInput({
      ...READY,
      displayName: ' Job hunt ',
      channel: 'chrome',
      headless: true,
      useProxy: true,
      proxy: {
        server: 'http://10.0.0.5:3128',
        username: 'u',
        passwordEnv: 'BH_PW',
        label: '',
        bypass: '',
      },
      locale: 'en-CA',
      timezoneId: 'America/Toronto',
      access: 'listed',
      principals: ['agent:a'],
      harnesses: ['claude-code'],
      unseal: { ...READY.unseal, evaluate: true },
      unsealPrincipals: ['agent:a'],
    });
    expect(body).toMatchObject({
      display_name: 'Job hunt',
      channel: 'chrome',
      headless: true,
      proxy: { server: 'http://10.0.0.5:3128', username: 'u', password_env: 'BH_PW' },
      locale: 'en-CA',
      timezone_id: 'America/Toronto',
      policy: {
        authorized_principals: ['agent:a'],
        harnesses: ['claude-code'],
        unseal: { evaluate: true, cookie_values: false, principals: ['agent:a'] },
      },
    });
    expect(toTemplateInput({ ...READY, access: 'all' }).policy?.authorized_principals).toEqual([]);
  });

  it('sends a server issue back to its step', () => {
    expect(stepOfIssue('body.name')).toBe(1);
    expect(stepOfIssue('body.sites.0.site_id')).toBe(2);
    expect(stepOfIssue('proxy.server')).toBe(3);
    expect(stepOfIssue('body.policy.authorized_principals')).toBe(4);
    expect(
      issuesOf({ issues: [{ path: 'body.sites.0.site_id', message: 'a public suffix' }] }),
    ).toEqual([{ field: 'sites.0.site_id', message: 'a public suffix' }]);
  });
});

describe('sign-in error states', () => {
  const error = (code: string, details: Record<string, unknown> = {}) =>
    new AppError({
      code: code as never,
      status: 409,
      title: code,
      message: code,
      retryable: 'never',
      details,
    });

  it('reads the failed browser’s cause', () => {
    const t = template(1, {
      proxy: {
        server: 'http://10.0.0.5:3128',
        bypass: null,
        username: null,
        password_env: null,
        label: 'p',
      },
    });
    const failed = (last_error: string) => hostView({ state: 'failed', last_error });
    expect(
      signInProblem({ error: null, host: failed('no_display'), template: t, windowLost: false }),
    ).toEqual({ kind: 'no_display' });
    expect(
      signInProblem({
        error: null,
        host: failed('proxy_unreachable'),
        template: t,
        windowLost: false,
      }),
    ).toEqual({ kind: 'proxy_unreachable', proxy: 'http://10.0.0.5:3128' });
  });

  it('maps the start errors', () => {
    const host = hostView();
    const t = template(1, { status: 'recording' });
    expect(
      signInProblem({ error: error('SESSION_LIMIT_REACHED'), host, template: t, windowLost: false })
        ?.kind,
    ).toBe('session_limit');
    expect(
      signInProblem({
        error: error('BROWSER_NOT_INSTALLED', {
          install_command: 'browserhive init --installChrome',
        }),
        host,
        template: t,
        windowLost: false,
      }),
    ).toEqual({ kind: 'not_installed', command: 'browserhive init --installChrome' });
    expect(
      signInProblem({
        error: null,
        host: hostView({ state: 'crashed' }),
        template: t,
        windowLost: true,
      })?.kind,
    ).toBe('crashed');
    expect(signInProblem({ error: null, host, template: t, windowLost: false })).toBeNull();
  });

  it('finds the recording window among the template’s sessions', () => {
    const base = {
      live: true,
      slug: 'recording',
      template: {
        template_id: 'tp-0000000001',
        name: 'x',
        version: null,
        mode: 'maintenance' as const,
      },
    };
    expect(recordingSessionOf([base as never])).not.toBeNull();
    expect(recordingSessionOf([{ ...base, slug: 'maintenance' } as never])).toBeNull();
    expect(recordingSessionOf([{ ...base, live: false } as never])).toBeNull();
  });
});

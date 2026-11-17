/** @module app/templates/launch-recheck.test — a template launch checks its gate again once its session is registered (deferred D24): an edit that raced the launch closes the session and answers the template's own code, never `INTERNAL_ERROR`; typed refusals pass through. */

import { beforeEach, describe, expect, it } from 'bun:test';
import { InMemoryRepositories } from '../../../test/helpers/in-memory-repos.ts';
import { templateRecord } from '../../../test/persistence/helpers.ts';
import type { Session } from '../../domain/session/session.ts';
import { AppError, isAppError } from '../../kernel/errors/app-error.ts';
import type { TemplateRecord } from '../../ports/persistence/index.ts';
import { type LaunchGateFacts, launchWithRecheck, staleLaunchRefusal } from './launch-recheck.ts';

const TEMPLATE = templateRecord();
const ID = TEMPLATE.templateId;
// A test double: the recheck only reads the session's id.
const SESSION = { id: 'jobs-12345678' } as unknown as Session;

let repos: InMemoryRepositories;
let closed: string[];
let allowed: (current: TemplateRecord) => boolean;
let facts: LaunchGateFacts;

beforeEach(async () => {
  repos = new InMemoryRepositories();
  closed = [];
  allowed = () => true;
  facts = { name: 'job-hunt', templateId: ID, allowed: (current) => allowed(current) };
  await repos.templates.insert(TEMPLATE);
});

function close(sessionId: string): Promise<void> {
  closed.push(sessionId);
  return Promise.resolve();
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected a refusal');
}

function codeOf(err: unknown): string {
  return isAppError(err) ? err.code : 'other';
}

describe('staleLaunchRefusal', () => {
  it('null while the template is still launchable', async () => {
    expect(await staleLaunchRefusal(repos, facts)).toBeNull();
  });

  it('deleted, renamed away or no longer allowed → TEMPLATE_NOT_FOUND by the launch name', async () => {
    allowed = (current) => current.name === 'job-hunt';
    await repos.templates.update(ID, { name: 'renamed' });
    const renamed = await staleLaunchRefusal(repos, facts);
    expect(renamed?.code).toBe('TEMPLATE_NOT_FOUND');
    expect(renamed?.details).toEqual({ template: 'job-hunt' });
    await repos.templates.remove(ID);
    expect((await staleLaunchRefusal(repos, facts))?.code).toBe('TEMPLATE_NOT_FOUND');
  });

  it('disabled → TEMPLATE_DISABLED', async () => {
    await repos.templates.update(ID, { status: 'disabled' });
    const refusal = await staleLaunchRefusal(repos, facts);
    expect(refusal?.code).toBe('TEMPLATE_DISABLED');
    expect(refusal?.details).toEqual({ template: 'job-hunt', reason: 'disabled' });
  });
});

describe('launchWithRecheck', () => {
  it('returns the session when nothing changed', async () => {
    expect(await launchWithRecheck(repos, facts, () => Promise.resolve(SESSION), close)).toBe(
      SESSION,
    );
    expect(closed).toEqual([]);
  });

  it('a template deleted during the launch closes the session: TEMPLATE_NOT_FOUND', async () => {
    const launch = async () => {
      await repos.templates.remove(ID);
      return SESSION;
    };
    expect(codeOf(await failure(launchWithRecheck(repos, facts, launch, close)))).toBe(
      'TEMPLATE_NOT_FOUND',
    );
    expect(closed).toEqual([SESSION.id]);
  });

  it('a grant revoked during the launch closes the session: TEMPLATE_NOT_FOUND', async () => {
    const launch = async () => {
      allowed = () => false;
      return SESSION;
    };
    expect(codeOf(await failure(launchWithRecheck(repos, facts, launch, close)))).toBe(
      'TEMPLATE_NOT_FOUND',
    );
    expect(closed).toEqual([SESSION.id]);
  });

  it('disabled during the launch closes the session: TEMPLATE_DISABLED', async () => {
    const launch = async () => {
      await repos.templates.update(ID, { status: 'disabled' });
      return SESSION;
    };
    expect(codeOf(await failure(launchWithRecheck(repos, facts, launch, close)))).toBe(
      'TEMPLATE_DISABLED',
    );
    expect(closed).toEqual([SESSION.id]);
  });

  it('a close that fails still answers the template code', async () => {
    const launch = async () => {
      await repos.templates.update(ID, { status: 'disabled' });
      return SESSION;
    };
    const failingClose = () => Promise.reject(new Error('already gone'));
    expect(codeOf(await failure(launchWithRecheck(repos, facts, launch, failingClose)))).toBe(
      'TEMPLATE_DISABLED',
    );
  });

  it('an INTERNAL_ERROR caused by an edit closing the session maps to the template code', async () => {
    const launch = async (): Promise<Session> => {
      await repos.templates.update(ID, { status: 'disabled' });
      throw new AppError('INTERNAL_ERROR', { ref: 'session closed' });
    };
    expect(codeOf(await failure(launchWithRecheck(repos, facts, launch, close)))).toBe(
      'TEMPLATE_DISABLED',
    );
    const untyped = async (): Promise<Session> => {
      await repos.templates.remove(ID);
      throw new Error('target closed');
    };
    expect(codeOf(await failure(launchWithRecheck(repos, facts, untyped, close)))).toBe(
      'TEMPLATE_NOT_FOUND',
    );
    expect(closed).toEqual([]);
  });

  it('an INTERNAL_ERROR without an edit stays itself', async () => {
    const boom = new AppError('INTERNAL_ERROR', { ref: 'x' });
    expect(await failure(launchWithRecheck(repos, facts, () => Promise.reject(boom), close))).toBe(
      boom,
    );
  });

  it('a typed refusal passes through even when the template changed', async () => {
    const refusal = new AppError('TEMPLATE_UNAVAILABLE', {
      template: 'job-hunt',
      reason: 'restarting',
      retry_after_ms: 1_000,
    });
    const launch = async (): Promise<Session> => {
      await repos.templates.remove(ID);
      throw refusal;
    };
    expect(await failure(launchWithRecheck(repos, facts, launch, close))).toBe(refusal);
  });

  it('a recheck that cannot read the template keeps the launch error', async () => {
    const boom = new Error('host gone');
    repos.templates.get = () => Promise.reject(new Error('db locked'));
    expect(await failure(launchWithRecheck(repos, facts, () => Promise.reject(boom), close))).toBe(
      boom,
    );
  });
});

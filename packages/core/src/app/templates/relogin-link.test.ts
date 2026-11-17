/** @module app/templates/relogin-link.test — linking a vault binding to a template site (spec 13 §8.4, §11.1 `PUT …/sites/{site_id}/relogin`): the binding gates a template fill would meet, **Allow this template**, the auto-relogin switch and form, unlinking, the audit row and `vaultLinkedBy`. */

import { beforeEach, describe, expect, it } from 'bun:test';
import type { BindingProblem } from '@browserhive/contracts/http';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { FakeIdGenerator } from '../../../test/helpers/fake-id-generator.ts';
import { InMemoryRepositories } from '../../../test/helpers/in-memory-repos.ts';
import { InMemoryOperatorActionRepository } from '../../../test/helpers/in-memory-vault-repos.ts';
import { RecordingEventBus } from '../../../test/helpers/recording-event-bus.ts';
import { templateRecord, templateSiteRecord } from '../../../test/persistence/helpers.ts';
import type { VaultBindingInput } from '../../domain/vault/bindings.ts';
import { AppError, isAppError } from '../../kernel/errors/app-error.ts';
import type { TemplateSiteRecord, VaultBindingRecord } from '../../ports/persistence/index.ts';
import type { DomainEvents } from '../events/catalog.ts';
import type { VaultAdmin } from '../vault/vault-admin.ts';
import { bindingProblems, ReloginLinks } from './relogin-link.ts';

const ID = templateRecord().templateId;
const PRINCIPAL = `template:${ID}`;
const FORM = { username: '#user', password: '#pass' };

function binding(patch: Partial<VaultBindingRecord> = {}): VaultBindingRecord {
  return {
    handle: 'github',
    tenantId: null,
    title: 'GitHub',
    itemName: 'GitHub',
    itemId: 'item-1',
    groupId: null,
    allowedOrigins: ['https://site-a.test'],
    authorizedPrincipals: ['p-agent'],
    authorizedSessionSlugs: ['shop'],
    allowAllSessions: false,
    redactUsername: false,
    requireNoEvaluate: false,
    dashboardConfirm: false,
    harnesses: null,
    version: 3,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

/** `getBinding`/`putBinding` over a map, like `VaultAdmin` (NOT_FOUND, CONFLICT on a stale version). */
class FakeAdmin implements Pick<VaultAdmin, 'getBinding' | 'putBinding'> {
  readonly bindings = new Map<string, VaultBindingRecord>();
  readonly puts: { handle: string; input: VaultBindingInput; ifVersion?: number }[] = [];

  async getBinding(handle: string): Promise<VaultBindingRecord> {
    const found = this.bindings.get(handle);
    if (found === undefined) throw new AppError('NOT_FOUND', {});
    return found;
  }

  async putBinding(
    handle: string,
    input: VaultBindingInput,
    ifVersion?: number,
  ): Promise<VaultBindingRecord> {
    this.puts.push({ handle, input, ...(ifVersion !== undefined && { ifVersion }) });
    const prior = this.bindings.get(handle);
    if (prior === undefined) throw new AppError('NOT_FOUND', {});
    if (ifVersion !== undefined && ifVersion !== prior.version) {
      throw new AppError('CONFLICT', { current_version: prior.version });
    }
    const next: VaultBindingRecord = {
      ...prior,
      ...(input.authorizedPrincipals !== undefined && {
        authorizedPrincipals: input.authorizedPrincipals,
      }),
      ...(input.authorizedSessionSlugs !== undefined && {
        authorizedSessionSlugs: input.authorizedSessionSlugs,
      }),
      version: prior.version + 1,
    };
    this.bindings.set(handle, next);
    return next;
  }
}

describe('bindingProblems', () => {
  const allowed = binding({
    authorizedPrincipals: [PRINCIPAL],
    authorizedSessionSlugs: ['relogin'],
  });
  const cases: ReadonlyArray<
    readonly [string, VaultBindingRecord | null, readonly BindingProblem[]]
  > = [
    ['no binding', null, ['binding_not_found']],
    ['every gate passes', allowed, []],
    ['slug by glob', { ...allowed, authorizedSessionSlugs: ['re*'] }, []],
    [
      'every session allowed',
      { ...allowed, authorizedSessionSlugs: [], allowAllSessions: true },
      [],
    ],
    ['open to every principal', { ...allowed, authorizedPrincipals: [] }, ['principals_open']],
    [
      'principal not listed',
      { ...allowed, authorizedPrincipals: ['p-agent'] },
      ['principal_not_listed'],
    ],
    // The template's own maintenance session satisfies any slug rule (review #81 M-1).
    ['a slug rule is no problem', { ...allowed, authorizedSessionSlugs: ['shop'] }, []],
    ['a harness list', { ...allowed, harnesses: ['claude-code'] }, ['harness_list']],
    ['an empty harness list', { ...allowed, harnesses: [] }, ['harness_list']],
    [
      'several at once',
      binding({ authorizedPrincipals: [], harnesses: [] }),
      ['principals_open', 'harness_list'],
    ],
  ];
  for (const [name, b, problems] of cases) {
    it(name, () => {
      expect(bindingProblems(b, ID)).toEqual([...problems]);
    });
  }
});

let repos: InMemoryRepositories;
let actions: InMemoryOperatorActionRepository;
let admin: FakeAdmin;
let bus: RecordingEventBus<DomainEvents>;
let changed: string[];
let links: ReloginLinks;

beforeEach(async () => {
  repos = new InMemoryRepositories();
  actions = new InMemoryOperatorActionRepository();
  admin = new FakeAdmin();
  bus = new RecordingEventBus<DomainEvents>();
  changed = [];
  links = new ReloginLinks({
    repos: { ...repos, operatorActions: actions },
    admin,
    ids: new FakeIdGenerator(),
    clock: new FakeClock(),
    bus,
    changed: (id) => changed.push(id),
  });
  admin.bindings.set('github', binding());
  await repos.templates.insert(templateRecord());
  await repos.templateSites.upsert(templateSiteRecord({ siteId: 'site-a.test' }));
});

async function site(): Promise<TemplateSiteRecord | undefined> {
  return (await repos.templateSites.list(ID)).find((s) => s.siteId === 'site-a.test');
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'resolved';
  } catch (err) {
    return isAppError(err) ? err.code : 'other';
  }
}

const LINK = { vaultHandle: 'github', allowTemplate: false } as const;

describe('ReloginLinks.put', () => {
  it('links a binding and reports the gates that would refuse the template', async () => {
    const res = await links.put(ID, 'www.site-a.test', LINK, 'admin');
    expect(res.site).toMatchObject({
      site_id: 'site-a.test',
      vault_handle: 'github',
      auto_relogin: false,
    });
    expect(res.binding_allows_template).toBe(false);
    expect(res.binding_problems).toEqual(['principal_not_listed']);
    expect(admin.puts).toEqual([]);
    expect(await site()).toMatchObject({ vaultHandle: 'github', vaultLinkedBy: 'admin' });
    expect(bus.names()).toEqual(['template.health']);
    expect(changed).toEqual([ID]);
  });

  it('Allow this template adds template:<id> and never a session slug (review #81 M-1)', async () => {
    const res = await links.put(ID, 'site-a.test', { ...LINK, allowTemplate: true }, 'admin');
    expect(admin.puts).toEqual([
      {
        handle: 'github',
        input: { authorizedPrincipals: ['p-agent', PRINCIPAL] },
        ifVersion: 3,
      },
    ]);
    expect(res.binding_allows_template).toBe(true);
    expect(res.binding_problems).toEqual([]);
  });

  it('Allow this template adds only what is missing, and nothing when allowed', async () => {
    admin.bindings.set(
      'github',
      binding({ authorizedPrincipals: [PRINCIPAL], allowAllSessions: true }),
    );
    const res = await links.put(ID, 'site-a.test', { ...LINK, allowTemplate: true }, 'admin');
    expect(admin.puts).toEqual([]);
    expect(res.binding_allows_template).toBe(true);
    admin.bindings.set('github', binding({ authorizedSessionSlugs: ['relogin'] }));
    await links.put(ID, 'site-a.test', { ...LINK, allowTemplate: true }, 'admin');
    expect(admin.puts[0]?.input).toEqual({ authorizedPrincipals: ['p-agent', PRINCIPAL] });
  });

  it('Allow this template refuses a binding open to every principal', async () => {
    admin.bindings.set('github', binding({ authorizedPrincipals: [] }));
    expect(
      await codeOf(links.put(ID, 'site-a.test', { ...LINK, allowTemplate: true }, 'admin')),
    ).toBe('VALIDATION_FAILED');
    expect(admin.puts).toEqual([]);
    expect((await site())?.vaultHandle).toBeNull();
  });

  it('a binding that changed meanwhile is CONFLICT', async () => {
    admin.bindings.set('github', binding({ version: 3 }));
    const stale = admin.getBinding.bind(admin);
    admin.getBinding = async (handle) => ({ ...(await stale(handle)), version: 2 });
    expect(
      await codeOf(links.put(ID, 'site-a.test', { ...LINK, allowTemplate: true }, 'admin')),
    ).toBe('CONFLICT');
  });

  it('auto_relogin without a form is refused; with one it is on', async () => {
    expect(
      await codeOf(links.put(ID, 'site-a.test', { ...LINK, autoRelogin: true }, 'admin')),
    ).toBe('VALIDATION_FAILED');
    const res = await links.put(
      ID,
      'site-a.test',
      { ...LINK, autoRelogin: true, form: FORM },
      'admin',
    );
    expect(res.site).toMatchObject({ auto_relogin: true, form: FORM });
    // Omitted fields keep their values.
    const again = await links.put(ID, 'site-a.test', LINK, 'admin');
    expect(again.site).toMatchObject({ auto_relogin: true, form: FORM });
  });

  it('an unknown binding is VALIDATION_FAILED; an unknown site or template TEMPLATE_NOT_FOUND', async () => {
    expect(
      await codeOf(links.put(ID, 'site-a.test', { ...LINK, vaultHandle: 'nope' }, 'admin')),
    ).toBe('VALIDATION_FAILED');
    expect(await codeOf(links.put(ID, 'other.test', LINK, 'admin'))).toBe('TEMPLATE_NOT_FOUND');
    expect(await codeOf(links.put('tp-missing', 'site-a.test', LINK, 'admin'))).toBe(
      'TEMPLATE_NOT_FOUND',
    );
  });

  it('without a vault it is VAULT_NOT_CONFIGURED', async () => {
    const off = new ReloginLinks({
      repos: { ...repos, operatorActions: actions },
      ids: new FakeIdGenerator(),
      clock: new FakeClock(),
    });
    expect(await codeOf(off.put(ID, 'site-a.test', LINK, 'admin'))).toBe('VAULT_NOT_CONFIGURED');
  });

  it('vault_handle null unlinks and turns auto-relogin off', async () => {
    await links.put(ID, 'site-a.test', { ...LINK, autoRelogin: true, form: FORM }, 'admin');
    const res = await links.put(
      ID,
      'site-a.test',
      { vaultHandle: null, autoRelogin: true, allowTemplate: true },
      'admin',
    );
    expect(res).toEqual({
      site: expect.objectContaining({ vault_handle: null, auto_relogin: false }),
      binding_allows_template: false,
      binding_problems: [],
    });
    expect(await site()).toMatchObject({
      vaultHandle: null,
      autoRelogin: false,
      vaultLinkedBy: null,
    });
    expect(admin.puts).toEqual([]);
  });

  it('writes the template.relogin_link audit row', async () => {
    await links.put(ID, 'site-a.test', { ...LINK, autoRelogin: true, form: FORM }, 'admin');
    expect(actions.rows).toMatchObject([
      {
        principalId: 'admin',
        action: 'template.relogin_link',
        resourceKind: 'template',
        resourceId: ID,
        details: {
          site_id: 'site-a.test',
          vault_handle: 'github',
          auto_relogin: true,
          allow_template: false,
        },
      },
    ]);
  });

  it('vaultLinkedBy stays with whoever linked the binding until it changes', async () => {
    admin.bindings.set('gitlab', binding({ handle: 'gitlab' }));
    await links.put(ID, 'site-a.test', LINK, 'alice');
    await links.put(ID, 'site-a.test', { ...LINK, autoRelogin: true, form: FORM }, 'bob');
    expect((await site())?.vaultLinkedBy).toBe('alice');
    await links.put(ID, 'site-a.test', { ...LINK, vaultHandle: 'gitlab' }, 'bob');
    expect((await site())?.vaultLinkedBy).toBe('bob');
  });
});

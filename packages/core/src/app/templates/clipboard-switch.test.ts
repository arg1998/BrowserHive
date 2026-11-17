/** @module app/templates/clipboard-switch.test — "Deny clipboard writes" through `PATCH` (spec 13 §2.1, D18): the field is stored and audited by name, reaches a running browser live without a restart, the response says when pages already open need a browser restart, an unchanged value does nothing, and a browser that cannot take it live is restarted (a stopped one is left for its next start). */

import { beforeEach, describe, expect, it } from 'bun:test';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { FakeTemplateHostOps } from '../../../test/helpers/fake-host-ops.ts';
import { InMemoryRepositories, InMemoryUnitOfWork } from '../../../test/helpers/in-memory-repos.ts';
import { InMemoryOperatorActionRepository } from '../../../test/helpers/in-memory-vault-repos.ts';
import { FakeTemplateRuntime } from '../../../test/helpers/template-kit.ts';
import {
  TEMPLATE_ID,
  templateRecord,
  templateSiteRecord,
} from '../../../test/persistence/helpers.ts';
import { validateTemplatePatch } from '../../domain/templates/patch.ts';
import { TemplateEditService } from './template-edit.ts';

let repos: InMemoryRepositories & { operatorActions: InMemoryOperatorActionRepository };
let runtime: FakeTemplateRuntime;
let ops: FakeTemplateHostOps;
let applied: [string, boolean][];
let failLive: boolean;
let edit: TemplateEditService;

beforeEach(async () => {
  repos = Object.assign(new InMemoryRepositories(), {
    operatorActions: new InMemoryOperatorActionRepository(),
  });
  await repos.templates.insert(templateRecord());
  await repos.templateSites.upsert(templateSiteRecord());
  runtime = new FakeTemplateRuntime();
  ops = new FakeTemplateHostOps();
  applied = [];
  failLive = false;
  edit = new TemplateEditService({
    repos,
    uow: new InMemoryUnitOfWork(repos),
    runtime,
    ops,
    sessions: { peek: () => undefined, close: async () => true as never },
    ids: { eventId: () => 'e-1' },
    clock: new FakeClock(),
    logger: new CollectingLogger(),
    changed: () => undefined,
    clipboardWrites: async (id, deny) => {
      if (failLive) throw new Error('no browser session');
      applied.push([id, deny]);
    },
  });
});

describe('deny_clipboard_writes (D18)', () => {
  it('is a plain edit: no restart, no session re-check', () => {
    const out = validateTemplatePatch({ deny_clipboard_writes: true }, templateRecord(), 1);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.patch.denyClipboardWrites).toBe(true);
    expect(out.value.changed).toEqual(['deny_clipboard_writes']);
    expect(out.value.restart).toBe(false);
    expect(out.value.sessionsAffected).toBe(false);
  });

  it('is stored, audited by name and applied to the running browser live, both ways', async () => {
    runtime.hosts.set(TEMPLATE_ID, { state: 'running' });
    const on = await edit.update(TEMPLATE_ID, { deny_clipboard_writes: true }, { by: 'admin' });
    expect(on.template.deny_clipboard_writes).toBe(true);
    expect((await repos.templates.get(TEMPLATE_ID))?.denyClipboardWrites).toBe(true);
    const off = await edit.update(
      TEMPLATE_ID,
      { deny_clipboard_writes: false },
      { by: 'admin', ifMatch: on.template.version },
    );
    expect(off.template.deny_clipboard_writes).toBe(false);
    expect(applied).toEqual([
      [TEMPLATE_ID, true],
      [TEMPLATE_ID, false],
    ]);
    expect(repos.operatorActions.rows.map((r) => [r.action, r.details])).toEqual([
      ['template.update', { changed: ['deny_clipboard_writes'] }],
      ['template.update', { changed: ['deny_clipboard_writes'] }],
    ]);
    expect(ops.calls).toEqual([]);
  });

  it('the response says when only a browser restart gives the change full effect', async () => {
    runtime.hosts.set(TEMPLATE_ID, { state: 'running', clipboardNeedsRestart: true });
    const on = await edit.update(TEMPLATE_ID, { deny_clipboard_writes: true }, { by: 'admin' });
    expect(on.clipboard_needs_restart).toBe(true);
    runtime.hosts.set(TEMPLATE_ID, { state: 'stopped' });
    const off = await edit.update(TEMPLATE_ID, { deny_clipboard_writes: false }, { by: 'admin' });
    expect(off.clipboard_needs_restart).toBe(false);
    // Another edit does not carry it.
    const renamed = await edit.update(TEMPLATE_ID, { description: 'x' }, { by: 'admin' });
    expect(renamed.clipboard_needs_restart).toBeUndefined();
  });

  it('an unchanged value writes and applies nothing', async () => {
    const out = await edit.update(TEMPLATE_ID, { deny_clipboard_writes: false }, { by: 'a' });
    expect(out.template.version).toBe(1);
    expect(applied).toEqual([]);
    expect(repos.operatorActions.rows).toEqual([]);
  });

  it('a running browser that cannot take it live is restarted; a stopped one is not', async () => {
    failLive = true;
    await edit.update(TEMPLATE_ID, { deny_clipboard_writes: true }, { by: 'a' });
    expect(ops.calls).toEqual([]);
    runtime.hosts.set(TEMPLATE_ID, { state: 'running' });
    await edit.update(TEMPLATE_ID, { deny_clipboard_writes: false }, { by: 'a' });
    expect(ops.calls).toEqual([`restart:${TEMPLATE_ID}`]);
  });
});

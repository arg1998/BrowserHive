/** @module app/templates/identity-drift.test — an identity drift is kept with the template's row, so a restart still shows it (spec 13 §2.2, deferred D23). */

import { describe, expect, it } from 'bun:test';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { FakeTemplateHost } from '../../../test/helpers/fake-template-host.ts';
import { templateRecord } from '../../../test/persistence/helpers.ts';

import type {
  ObservedIdentityRecord,
  TemplatePatch,
  TemplateRecord,
} from '../../ports/persistence/index.ts';
import { STOPPED_HOST } from '../../ports/template-runtime.ts';
import { IdentityObserver } from './host-shutdown.ts';
import { toTemplateSummary } from './views.ts';

const OBSERVED: ObservedIdentityRecord = {
  chromeMajor: '140',
  userAgent: 'ua',
  uaCh: {
    brands: [],
    fullVersionList: [],
    platform: 'Linux',
    platformVersion: '',
    architecture: '',
    bitness: '',
  },
  screen: { width: 1280, height: 800, deviceScaleFactor: 1 },
  window: { width: 1280, height: 800 },
  observedAt: 1,
};

function hostOn(major: string): FakeTemplateHost {
  const host = new FakeTemplateHost('tp-fixture001');
  Object.assign(host, { browserInfo: { version: `${major}.0.1.2`, sandboxed: true } });
  return host;
}

async function observe(template: TemplateRecord, major: string) {
  const updates: TemplatePatch[] = [];
  const observer = new IdentityObserver({
    templates: {
      update: async (id, patch) => {
        updates.push(patch);
        return { ...template, templateId: id, ...patch } as TemplateRecord;
      },
    },
    clock: new FakeClock(),
    log: new CollectingLogger(),
    changed: () => undefined,
  });
  observer.started(template, hostOn(major));
  await Promise.resolve();
  return { observer, updates };
}

describe('identity drift (deferred D23)', () => {
  it('stores the drift with the observed identity and shows it after a restart', async () => {
    const template = templateRecord({ identityObserved: OBSERVED });
    const { observer, updates } = await observe(template, '141');
    expect(observer.drift(template.templateId)).toEqual({ from: '140', to: '141' });
    const stored = updates[0]?.identityObserved;
    expect(stored?.drift).toMatchObject({ from: '140', to: '141' });
    // A new process: nothing in memory, the row still says so.
    const restarted = { ...template, identityObserved: stored ?? null };
    expect(toTemplateSummary(restarted, [], STOPPED_HOST).identity_drift).toEqual({
      from: '140',
      to: '141',
    });
  });

  it('clears the stored drift when a start sees the recorded major again', async () => {
    const template = templateRecord({
      identityObserved: { ...OBSERVED, drift: { from: '140', to: '141', at: 1 } },
    });
    const { updates } = await observe(template, '140');
    expect(updates).toHaveLength(1);
    expect(updates[0]?.identityObserved?.drift).toBeUndefined();
  });
});

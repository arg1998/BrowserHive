/** @module app/site-packs/webrtc-host-flags.test — `webrtc-policy` (spec 13 §3.2, §9.4): a host start gets the strictest policy of the template's enabled sites; a running host whose desired switches changed (`site_pack.changed`, `template.changed`) restarts once until its next start; a stopped host, an unchanged set, a disabled site or no lookup (`sitePacks=false`) restart nothing; a change landing while the host starts restarts it once it is running (review PR #84 M1). */

import { describe, expect, it } from 'bun:test';
import { RecordingEventBus } from '../../../test/helpers/recording-event-bus.ts';
import { createCollectingLogger } from '../../../test/helpers/test-logger.ts';
import { templateRecord, templateSiteRecord } from '../../../test/persistence/helpers.ts';
import type { TemplateSiteRecord } from '../../ports/persistence/index.ts';
import type { SitePackLookup } from '../../ports/site-packs.ts';
import type { DomainEvents } from '../events/catalog.ts';
import { effective, lookupOf } from './strategy-test-packs.ts';
import { HostFlagsWatch } from './webrtc-host-flags.ts';

const STRICT = '--force-webrtc-ip-handling-policy=disable_non_proxied_udp';
const PUBLIC = '--force-webrtc-ip-handling-policy=default_public_interface_only';
const template = templateRecord();
const ID = template.templateId;

const linkedin = (policy: string) =>
  effective({ strategies: [{ id: 'webrtc-policy', params: { policy } }] });
const other = (policy: string | null) =>
  effective({
    id: 'site-b.test',
    domains: ['site-b.test'],
    sign_in: { url: { host: 'site-b.test', path: '/login' }, human_only: false },
    signed_in: {
      probe: { host: 'site-b.test', path: '/me' },
      kind: 'redirect',
      signed_out_redirects: ['site-b.test/login*'],
    },
    guards: [],
    element_guards: [],
    challenges: [],
    pacing: { rules: [], min_launch_gap_s: 0 },
    strategies: policy === null ? [] : [{ id: 'webrtc-policy', params: { policy } }],
  });

function world(initial: SitePackLookup | null, sites: TemplateSiteRecord[]) {
  const bus = new RecordingEventBus<DomainEvents>();
  let lookup = initial;
  let running = true;
  const restarts: string[] = [];
  const watch = new HostFlagsWatch({
    sites: { list: async () => sites },
    lookup: () => lookup,
    running: () => running,
    restart: async (id) => void restarts.push(id),
    bus,
    logger: createCollectingLogger(),
  });
  const changed = () =>
    bus.publish('template.changed', {
      type: 'template.changed',
      template: { template_id: ID },
    } as unknown as DomainEvents['template.changed']);
  const hostState = (state: 'starting' | 'running') =>
    bus.publish('template.host', {
      type: 'template.host',
      template_id: ID,
      host: { state },
    } as unknown as DomainEvents['template.host']);
  const packChanged = () =>
    bus.publish('site_pack.changed', {
      type: 'site_pack.changed',
    } as unknown as DomainEvents['site_pack.changed']);
  return {
    watch,
    restarts,
    changed,
    packChanged,
    hostState,
    setRunning: (value: boolean) => {
      running = value;
    },
    swap: (next: SitePackLookup | null) => {
      lookup = next;
    },
    stopHost: () => {
      running = false;
    },
    settle: () => new Promise((r) => setTimeout(r, 5)),
  };
}

const site = (siteId: string, packId: string, enabled = true) =>
  templateSiteRecord({ siteId, packId, enabled });

describe('HostFlagsWatch', () => {
  it('a start gets the strictest policy of the enabled sites', async () => {
    const sites = [site('linkedin.com', 'linkedin.com'), site('site-b.test', 'site-b.test')];
    const w = world(
      lookupOf(linkedin('default_public_interface_only'), other('disable_non_proxied_udp')),
      sites,
    );
    expect(await w.watch.hostFlags(template)).toEqual([STRICT]);
    const one = world(lookupOf(linkedin('default_public_interface_only'), other(null)), sites);
    expect(await one.watch.hostFlags(template)).toEqual([PUBLIC]);
    const disabled = world(
      lookupOf(linkedin('default_public_interface_only'), other('disable_non_proxied_udp')),
      [site('linkedin.com', 'linkedin.com'), site('site-b.test', 'site-b.test', false)],
    );
    expect(await disabled.watch.hostFlags(template)).toEqual([PUBLIC]);
    expect(await world(null, sites).watch.hostFlags(template)).toEqual([]);
  });

  it('a running host restarts once when its switches change, until its next start', async () => {
    const sites = [site('linkedin.com', 'linkedin.com')];
    const w = world(lookupOf(other(null)), sites);
    expect(await w.watch.hostFlags(template)).toEqual([]);
    w.packChanged();
    await w.settle();
    expect(w.restarts).toEqual([]);
    w.swap(lookupOf(linkedin('disable_non_proxied_udp')));
    w.packChanged();
    w.changed();
    await w.settle();
    expect(w.restarts).toEqual([ID]);
    // The next start takes the new switches; a revert restarts again.
    expect(await w.watch.hostFlags(template)).toEqual([STRICT]);
    w.swap(null);
    w.changed();
    await w.settle();
    expect(w.restarts).toEqual([ID, ID]);
  });

  it('a stopped host is not restarted (its next start reads the switches)', async () => {
    const w = world(lookupOf(other(null)), [site('linkedin.com', 'linkedin.com')]);
    await w.watch.hostFlags(template);
    w.stopHost();
    w.swap(lookupOf(linkedin('disable_non_proxied_udp')));
    w.packChanged();
    await w.settle();
    expect(w.restarts).toEqual([]);
    w.watch.stop();
  });

  it('a pack change while the host starts restarts it once it is running (the review PoC)', async () => {
    const w = world(lookupOf(other(null)), [site('linkedin.com', 'linkedin.com')]);
    w.setRunning(false);
    // The start read the switches (none); the browser is still launching.
    expect(await w.watch.hostFlags(template)).toEqual([]);
    w.hostState('starting');
    // The operator approves a version selecting `webrtc-policy` meanwhile.
    w.swap(lookupOf(linkedin('disable_non_proxied_udp')));
    w.packChanged();
    await w.settle();
    expect(w.restarts).toEqual([]);
    w.setRunning(true);
    w.hostState('running');
    await w.settle();
    expect(await w.watch.desired(ID)).toEqual([STRICT]);
    expect(w.restarts).toEqual([ID]);
    // Running with what it started with: reaching `running` again restarts nothing.
    expect(await w.watch.hostFlags(template)).toEqual([STRICT]);
    w.hostState('running');
    await w.settle();
    expect(w.restarts).toEqual([ID]);
    w.watch.stop();
  });
});

/** @module features/templates/live.test — the `templates` topic's cache patches (a browser state and a site's health patch the cached detail in place; versions and operations refresh their own queries; changes refresh only that template) and which session events touch template counts; the sign-in step's live summary */
import { describe, expect, it } from 'bun:test';
import type { WsFeedEvent } from '@browserhive/contracts/ws';
import { QueryClient } from '@tanstack/react-query';
import { keys } from '@/lib/api/keys.ts';
import {
  hostView,
  signedInSite,
  templateDetail,
  templateSite,
  tid,
} from '../../../test/fixtures/templates.ts';
import { applyTemplateEvent, templateOfSessionEvent } from './live.ts';
import { signInAnnouncement } from './wizard/SignInSites.tsx';

const ID = tid(1);
const ev = (payload: Record<string, unknown>) => ({ v: 1, ...payload }) as unknown as WsFeedEvent;

function seeded() {
  const qc = new QueryClient();
  qc.setQueryData(
    keys.templates.detail(ID),
    templateDetail({ sites: [templateSite('linkedin.com')] }),
  );
  qc.setQueryData(keys.templates.detail(tid(2)), templateDetail());
  qc.setQueryData(keys.templates.list({}), { data: [] });
  qc.setQueryData(keys.templates.versions(ID), { data: [] });
  return qc;
}
const stale = (qc: QueryClient, key: readonly unknown[]) => qc.getQueryState(key)?.isInvalidated;

describe('templates topic', () => {
  it('patches the browser state of the cached template in place', () => {
    const qc = seeded();
    applyTemplateEvent(
      qc,
      ev({ type: 'template.host', template_id: ID, host: hostView({ state: 'crashed' }) }),
    );
    expect(
      qc.getQueryData<ReturnType<typeof templateDetail>>(keys.templates.detail(ID))?.host.state,
    ).toBe('crashed');
    expect(stale(qc, keys.templates.list({}))).toBe(true);
    expect(stale(qc, keys.templates.detail(tid(2)))).toBe(false);
  });

  it('patches a site’s health on the cached template', () => {
    const qc = seeded();
    applyTemplateEvent(
      qc,
      ev({ type: 'template.health', template_id: ID, site: signedInSite('linkedin.com') }),
    );
    const detail = qc.getQueryData<ReturnType<typeof templateDetail>>(keys.templates.detail(ID));
    expect(detail?.sites[0]?.health.state).toBe('signed_in');
    expect(detail?.template.sites[0]?.health.state).toBe('signed_in');
  });

  it('refreshes versions on a version and the template once an operation ends', () => {
    const qc = seeded();
    applyTemplateEvent(qc, ev({ type: 'template.version', template_id: ID, version: {} }));
    expect(stale(qc, keys.templates.versions(ID))).toBe(true);
    expect(stale(qc, keys.templates.detail(ID))).toBe(false);
    applyTemplateEvent(
      qc,
      ev({
        type: 'template.operation',
        operation_id: 'op-aaaaaaaaaaaa',
        kind: 'restore',
        state: 'done',
        template_id: ID,
      }),
    );
    expect(stale(qc, keys.templates.detail(ID))).toBe(true);
    expect(stale(qc, keys.templates.detail(tid(2)))).toBe(false);
  });

  it('drops a removed template', () => {
    const qc = seeded();
    applyTemplateEvent(qc, ev({ type: 'template.removed', template_id: ID }));
    expect(qc.getQueryData(keys.templates.detail(ID))).toBeUndefined();
  });

  it('only opening and closing template sessions touch the counts', () => {
    const session = (template?: unknown) => ({
      session_id: 'shop-00000001',
      ...(template !== undefined && { template }),
    });
    expect(
      templateOfSessionEvent(
        ev({
          type: 'session.opened',
          session: session({ template_id: ID, name: 'x', version: 1, mode: 'live' }),
        }),
      ),
    ).toBe(ID);
    expect(
      templateOfSessionEvent(ev({ type: 'session.opened', session: session() })),
    ).toBeUndefined();
    expect(
      templateOfSessionEvent(
        ev({ type: 'session.updated', session: session({ template_id: ID }) }),
      ),
    ).toBeUndefined();
    expect(
      templateOfSessionEvent(ev({ type: 'session.closed', session_id: 'shop-00000001' })),
    ).toBeNull();
  });
});

describe('sign-in live summary', () => {
  it('announces only changes, with the count', () => {
    const sites = [signedInSite('linkedin.com'), templateSite('indeed.com')];
    expect(signInAnnouncement(new Map(), sites)).toBeNull();
    const before = new Map([
      ['linkedin.com', 'unknown' as const],
      ['indeed.com', 'unknown' as const],
    ]);
    expect(signInAnnouncement(before, sites)).toBe(
      '1 of 2 sites signed in. linkedin.com signed in.',
    );
  });
});

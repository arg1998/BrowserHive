/** @module features/sessions/live/live-status.test — the takeover gate (pending `takeover` attention only), the status pill (Idle is not an error) and the stream numbers popover */
import { describe, expect, it } from 'bun:test';
import type { OperatorRequestRow } from '@browserhive/contracts/http';
import { IDLE_AFTER_MS, livePillState, streamStats, takeoverRequest } from './live-status.ts';

function request(patch: Partial<OperatorRequestRow>): OperatorRequestRow {
  return {
    request_id: 'r-01HZX000000000000000000001',
    kind: 'attention',
    session_id: 'shop-00000001',
    session_slug: 'shop',
    owner: 'claude',
    reason: 'Solve the captcha',
    mode: 'takeover',
    options: null,
    status: 'pending',
    message: null,
    resolved_by: null,
    resolution_reason: null,
    created_at: 1,
    resolved_at: null,
    deadline_at: null,
    waited_ms: null,
    page_url: null,
    tool: null,
    event_id: null,
    entry_name: null,
    ...patch,
  } as OperatorRequestRow;
}

describe('takeover gate', () => {
  it('opens only for a pending takeover attention request on a live session', () => {
    const takeover = request({});
    expect(takeoverRequest({ live: true }, [takeover])).toBe(takeover);
    expect(takeoverRequest({ live: true }, [request({ mode: 'notify' })])).toBeNull();
    expect(takeoverRequest({ live: true }, [request({ status: 'resolved' })])).toBeNull();
    expect(
      takeoverRequest({ live: true }, [request({ kind: 'vault_confirm', mode: null })]),
    ).toBeNull();
    expect(takeoverRequest({ live: false }, [takeover])).toBeNull();
    expect(takeoverRequest({ live: true }, undefined)).toBeNull();
    const notify = request({ mode: 'notify', request_id: 'r-01HZX000000000000000000002' as never });
    expect(takeoverRequest({ live: true }, [notify, takeover])).toBe(takeover);
  });
});

describe('live status pill', () => {
  it('reads idle (not broken) when frames stop because the page is still', () => {
    expect(livePillState('streaming', 100)).toBe('live');
    expect(livePillState('streaming', IDLE_AFTER_MS + 1)).toBe('idle');
    expect(livePillState('waiting', null)).toBe('connecting');
    expect(livePillState('disconnected', 5000)).toBe('reconnecting');
    expect(livePillState('offline', null)).toBe('ended');
    expect(livePillState('failed', null)).toBe('failed');
    expect(livePillState('stopped', null)).toBe('stopped');
    expect(livePillState('paused', 9000)).toBe('paused');
  });

  it('lists the stream numbers as label/value rows', () => {
    expect(streamStats(null, null, { fps: 0, dropped: 0, received: 0, ageMs: null })).toBeNull();
    expect(
      streamStats(
        { width: 1280, height: 720 },
        { width: 704, height: 396 },
        { fps: 12, dropped: 3, received: 40, ageMs: 2400 },
      ),
    ).toEqual([
      { label: 'Page', value: '1280×720' },
      { label: 'Stream', value: '704×396' },
      { label: 'Frame rate', value: '12 fps' },
      { label: 'Dropped', value: '3' },
      { label: 'Last frame', value: '2.4 s ago' },
    ]);
    expect(
      streamStats(
        { width: 1280, height: 720 },
        { width: 1280, height: 720 },
        { fps: 0, dropped: 0, received: 1, ageMs: 20 },
      ),
    ).toEqual([
      { label: 'Page', value: '1280×720' },
      { label: 'Frame rate', value: '0 fps' },
      { label: 'Last frame', value: 'just now' },
    ]);
  });
});

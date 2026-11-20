/** @module interface/ws/cdp-bridge.test — the CDP adapter waits out a navigation's frame swap (D30 d): `Page.startScreencast` and the initial-frame capture try again while DevTools answers "Not attached to an active page", and only then. */

import { describe, expect, it } from 'bun:test';
import type { CDPSession } from '../../ports/page-types.ts';
import { cdpSessionBridge, FRAME_SWAP_MESSAGE, FRAME_SWAP_TRIES } from './cdp-bridge.ts';

/** A CDP session whose `send` fails `refusals` times per method with `message`, then answers. */
function fakeCdp(refusals: number, message: string) {
  const calls: string[] = [];
  const left = new Map<string, number>();
  const cdp = {
    send: async (method: string) => {
      calls.push(method);
      const remaining = left.get(method) ?? refusals;
      if (remaining > 0) {
        left.set(method, remaining - 1);
        throw new Error(`Protocol error (${method}): ${message}`);
      }
      if (method === 'Page.getLayoutMetrics') {
        return { cssVisualViewport: { clientWidth: 800, clientHeight: 600, scale: 1 } };
      }
      if (method === 'Page.captureScreenshot') return { data: 'AAAA' };
      return {};
    },
  };
  return { cdp: cdp as unknown as CDPSession, calls };
}

const params = { quality: 60, maxWidth: 1280, maxHeight: 720 };
const noWait = { sleep: async () => undefined };

describe('cdpSessionBridge across a frame swap (D30 d)', () => {
  it('starts the screencast once the navigation committed', async () => {
    const { cdp, calls } = fakeCdp(3, FRAME_SWAP_MESSAGE);
    await cdpSessionBridge(cdp, noWait).startScreencast(params);
    expect(calls).toEqual(Array(4).fill('Page.startScreencast'));
  });

  it('captures the initial frame once the navigation committed', async () => {
    const { cdp, calls } = fakeCdp(2, FRAME_SWAP_MESSAGE);
    const frame = await cdpSessionBridge(cdp, noWait).captureFrame(60);
    expect(frame.metadata).toEqual({
      deviceWidth: 800,
      deviceHeight: 600,
      pageScaleFactor: 1,
      offsetTop: 0,
    });
    expect(calls.filter((m) => m === 'Page.captureScreenshot')).toHaveLength(3);
  });

  it('fails at once on any other error, and after its tries on a swap that never ends', async () => {
    const other = fakeCdp(1, 'Target closed');
    await expect(cdpSessionBridge(other.cdp, noWait).startScreencast(params)).rejects.toThrow(
      'Target closed',
    );
    expect(other.calls).toHaveLength(1);
    const stuck = fakeCdp(Number.POSITIVE_INFINITY, FRAME_SWAP_MESSAGE);
    await expect(cdpSessionBridge(stuck.cdp, noWait).startScreencast(params)).rejects.toThrow(
      FRAME_SWAP_MESSAGE,
    );
    expect(stuck.calls).toHaveLength(FRAME_SWAP_TRIES);
  });
});

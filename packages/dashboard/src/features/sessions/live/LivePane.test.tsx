/** @module features/sessions/live/LivePane.test — screencast start over the socket, binary frames → Live pill, takeover input only through an open `takeover` request and mapped through the fitted frame, `INPUT_NOT_PERMITTED` toast with the code, failure with Retry, `?takeover=1` arms capture, the ended state is not a black box */

import { describe, expect, it } from 'bun:test';
import type { OperatorRequestRow, SessionSummary } from '@browserhive/contracts/http';
import { writeScreencastHeader } from '@browserhive/contracts/ws';
import { useState } from 'react';
import { attentionRequest, sessionSummary, sid } from '../../../../test/fixtures/sessions.ts';
import { expectNoA11yViolations } from '../../../../test/helpers/axe.ts';
import { renderPage } from '../../../../test/helpers/page-harness.tsx';
import { act, fireEvent, screen, waitFor } from '../../../../test/helpers/render.tsx';
import { LivePane } from './LivePane.tsx';
import { takeoverRequest } from './live-status.ts';

const ID = sid(1);
const RECT = {
  left: 0,
  top: 0,
  width: 640,
  height: 360,
  right: 640,
  bottom: 360,
  x: 0,
  y: 0,
  toJSON: () => ({}),
};

/** Lets a test replace the session the pane renders (e.g. it closes while watched). */
const control: { setSession?: (session: SessionSummary) => void } = {};

function mount(
  takeover: OperatorRequestRow | null,
  options: { live?: boolean; arm?: boolean; onArmed?: () => void } = {},
) {
  const initial = sessionSummary(1, {
    live: options.live ?? true,
    ...(options.live === false && { state: 'closed', closed_at: 1, closed_reason: 'user' }),
  });
  function Harness() {
    const [session, setSession] = useState(initial);
    control.setSession = setSession;
    return (
      <LivePane
        session={session}
        takeover={takeover}
        gateKnown
        vaultEnabled={false}
        armTakeover={options.arm ?? false}
        onArmed={options.onArmed ?? (() => undefined)}
        onClose={() => undefined}
        layout="split"
      />
    );
  }
  return renderPage({ path: '/', component: Harness, routes: {}, url: '/' });
}

function frame(seq: number): Uint8Array {
  const header = writeScreencastHeader({
    magic: 'BHSC',
    ordinal: 1,
    seq,
    width: 1280,
    height: 720,
  });
  const bytes = new Uint8Array(header.byteLength + 4);
  bytes.set(header);
  bytes.set([0xff, 0xd8, 0xff, 0xd9], header.byteLength);
  return bytes;
}

async function startStream(view: ReturnType<typeof mount>) {
  await screen.findByRole('img', { name: /Live view of shop/ });
  const socket = view.connect();
  await waitFor(() => expect(socket.sentOfType('screencast.start')).toHaveLength(1));
  const start = socket.sentOfType('screencast.start')[0];
  expect(start).toMatchObject({ session_id: ID, quality: 80 });
  await act(async () => {
    socket.receive({
      v: 1,
      kind: 'reply',
      seq: 1,
      ts: 1,
      corr: start?.['corr'],
      payload: { type: 'screencast.started', topic: `screencast:${ID}`, ordinal: 1 },
    });
    socket.receiveBinary(frame(1));
  });
  await waitFor(() => expect(screen.getByTestId('live-status').textContent).toBe('Live'));
  return socket;
}

describe('LivePane', () => {
  it('streams frames and sends takeover input mapped through the fitted frame; rejected input raises a toast with the code', async () => {
    const view = mount(attentionRequest());
    const socket = await startStream(view);
    expect(screen.getByText('Takeover open')).toBeDefined();
    const canvas = screen.getByRole('img', { name: /Live view of shop/ });
    canvas.getBoundingClientRect = () => RECT;
    await act(async () => {
      fireEvent.pointerDown(canvas, { clientX: 320, clientY: 180, button: 0, detail: 1 });
    });
    const input = socket.sentOfType('input')[0];
    expect(input).toMatchObject({
      session_id: ID,
      input: {
        type: 'mouse',
        action: 'mousePressed',
        x: 640,
        y: 360,
        button: 'left',
        clickCount: 1,
      },
    });
    await act(async () => {
      socket.receive({
        v: 1,
        kind: 'error',
        seq: 2,
        ts: 1,
        corr: input?.['corr'],
        payload: { code: 'INPUT_NOT_PERMITTED', title: 'Not permitted' },
      });
    });
    expect((await screen.findAllByText('Input rejected')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('INPUT_NOT_PERMITTED').length).toBeGreaterThan(0);
    await expectNoA11yViolations(view.container, { disable: ['aria-hidden-focus'] });
  });

  it('is view-only when the gate is closed (no takeover request) and never sends input', async () => {
    // The page passes `takeoverRequest(session, pending)`, which is `null` for notify requests too.
    const view = mount(takeoverRequest({ live: true }, [attentionRequest({ mode: 'notify' })]));
    const socket = await startStream(view);
    expect(screen.getByText('View only')).toBeDefined();
    expect(screen.queryByText('Capture keyboard')).toBeNull();
    const canvas = screen.getByRole('img', { name: /Live view of shop/ });
    canvas.getBoundingClientRect = () => RECT;
    await act(async () => {
      fireEvent.pointerDown(canvas, { clientX: 320, clientY: 180, button: 0 });
    });
    expect(socket.sentOfType('input')).toHaveLength(0);
  });

  it('arms keyboard capture for ?takeover=1 once frames arrive', async () => {
    let armed = 0;
    const view = mount(attentionRequest(), { arm: true, onArmed: () => (armed += 1) });
    await startStream(view);
    await waitFor(() => expect(armed).toBe(1));
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
  });

  it('shows the failure code with Retry, which starts the stream again', async () => {
    const view = mount(null);
    await screen.findByRole('img', { name: /Live view of shop/ });
    const socket = view.connect();
    await waitFor(() => expect(socket.sentOfType('screencast.start')).toHaveLength(1));
    await act(async () => {
      socket.receive({
        v: 1,
        kind: 'error',
        seq: 1,
        ts: 1,
        corr: socket.sentOfType('screencast.start')[0]?.['corr'],
        payload: { code: 'SESSION_NOT_AVAILABLE', title: 'not available' },
      });
    });
    expect(await screen.findByText('The live view could not start')).toBeDefined();
    expect(screen.getByText('SESSION_NOT_AVAILABLE')).toBeDefined();
    expect(screen.getByTestId('live-status').textContent).toBe('Failed');
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Retry' })[0] as HTMLElement);
    });
    await waitFor(() => expect(socket.sentOfType('screencast.start').length).toBeGreaterThan(1));
  });

  it('retries a start refused with SCREENCAST_FAILED once, then shows the failure', async () => {
    const view = mount(null);
    await screen.findByRole('img', { name: /Live view of shop/ });
    const socket = view.connect();
    await waitFor(() => expect(socket.sentOfType('screencast.start')).toHaveLength(1));
    const refuse = async (index: number) => {
      await act(async () => {
        socket.receive({
          v: 1,
          kind: 'error',
          seq: index + 1,
          ts: 1,
          corr: socket.sentOfType('screencast.start')[index]?.['corr'],
          payload: { code: 'SCREENCAST_FAILED', title: 'failed' },
        });
      });
    };
    await refuse(0);
    expect(screen.queryByText('The live view could not start')).toBeNull();
    await waitFor(() => expect(socket.sentOfType('screencast.start')).toHaveLength(2), {
      timeout: 2500,
    });
    await refuse(1);
    expect(await screen.findByText('The live view could not start')).toBeDefined();
    expect(socket.sentOfType('screencast.start')).toHaveLength(2);
  });

  it('keeps the last frame under an ended notice when the session closes while watched', async () => {
    const view = mount(null);
    const socket = await startStream(view);
    await act(async () => {
      control.setSession?.(
        sessionSummary(1, { live: false, state: 'closed', closed_at: 2, closed_reason: 'user' }),
      );
    });
    expect(await screen.findByText('This session has ended')).toBeDefined();
    expect(screen.getByText(/Closed by the agent/)).toBeDefined();
    expect(screen.getByRole('img', { name: /Live view of shop/ })).toBeDefined();
    expect(screen.getByTestId('live-status').textContent).toBe('Ended');
    await waitFor(() => expect(socket.sentOfType('screencast.stop')).toHaveLength(1));
  });

  it('says "closing" while the session drains instead of connecting', async () => {
    const view = mount(null);
    await startStream(view);
    await act(async () => {
      control.setSession?.(sessionSummary(1, { live: true, state: 'draining' }));
    });
    expect(await screen.findByText('The session is closing')).toBeDefined();
    expect(screen.getByTestId('live-status').textContent).toBe('Closing');
  });

  it('renders an ended state instead of a black stage for a closed session', async () => {
    mount(null, { live: false });
    expect(await screen.findByText('This session has ended')).toBeDefined();
    expect(screen.queryByRole('img', { name: /Live view of shop/ })).toBeNull();
    expect(screen.getByTestId('live-status').textContent).toBe('Ended');
  });
});

/** @module infra/browsers/frame-links — a page's out-of-process frames reached through DevTools alone (spec 13 §2.1, D18 "applies live"): `Target.setAutoAttach` without `flatten` on the page's own session (Patchright's `CDPSession` cannot address a flattened child), so frames Patchright does not track are reached too (measured on Patchright 1.63: those nested in an out-of-process sandboxed frame, and the frames of a page restored from the back/forward cache). Nothing is paused: `waitForDebuggerOnStart` is off. */

import type { CDPSession } from 'patchright';

/** How a link sends a command: `CDPSession.send`'s shape. */
export type TargetSend = CDPSession['send'];

/** A DevTools target the patch can talk to: a page's own session or a {@link FrameLink}. */
export interface FrameTarget {
  readonly send: TargetSend;
  /** The frames this target attached to without `flatten` (filled by {@link childFrames}). */
  readonly links: FrameLinks;
}

type RawSend = (method: string, params: object) => Promise<unknown>;

interface Message {
  readonly id?: number;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: unknown;
  readonly error?: { readonly message?: string };
}

interface AttachedParams {
  readonly sessionId: string;
  readonly targetInfo: { readonly type: string };
}

/** The frames one target attached to, and the routing of their messages. */
export class FrameLinks {
  readonly #send: RawSend;
  readonly #children = new Map<string, FrameLink>();
  readonly attached: FrameLink[] = [];

  constructor(send: RawSend) {
    this.#send = send;
  }

  /** An event of the owning target: attach, detach, or a message from one of its frames. */
  route(method: string, params: Record<string, unknown>): void {
    if (method === 'Target.attachedToTarget') {
      const { sessionId, targetInfo } = params as unknown as AttachedParams;
      if (targetInfo.type !== 'iframe') return;
      const link = new FrameLink(this.#send, sessionId);
      this.#children.set(sessionId, link);
      this.attached.push(link);
    } else if (method === 'Target.receivedMessageFromTarget') {
      const { sessionId, message } = params as { sessionId: string; message: string };
      this.#children.get(sessionId)?.receive(message);
    } else if (method === 'Target.detachedFromTarget') {
      const { sessionId } = params as { sessionId: string };
      this.#children.get(sessionId)?.close();
      this.#children.delete(sessionId);
    }
  }
}

/**
 * One out-of-process frame attached through its parent's session: commands go out through
 * `Target.sendMessageToTarget`, answers and events come back in `Target.receivedMessageFromTarget`.
 */
export class FrameLink implements FrameTarget {
  readonly #parent: RawSend;
  readonly #sessionId: string;
  readonly #pending = new Map<number, { resolve(v: unknown): void; reject(e: unknown): void }>();
  #nextId = 0;
  readonly links: FrameLinks;
  readonly send: TargetSend;

  constructor(parent: RawSend, sessionId: string) {
    this.#parent = parent;
    this.#sessionId = sessionId;
    this.links = new FrameLinks((method, params) => this.#raw(method, params));
    this.send = ((method: string, params?: object) =>
      this.#raw(method, params ?? {})) as unknown as TargetSend;
  }

  #raw(method: string, params: object): Promise<unknown> {
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      const message = JSON.stringify({ id, method, params });
      this.#parent('Target.sendMessageToTarget', { sessionId: this.#sessionId, message }).catch(
        (err: unknown) => {
          this.#pending.delete(id);
          reject(err);
        },
      );
    });
  }

  /** A message from the frame: an answer to one of ours, or an event (its own frames'). */
  receive(raw: string): void {
    const message = JSON.parse(raw) as Message;
    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);
      this.#pending.delete(message.id);
      if (message.error !== undefined) {
        pending?.reject(new Error(message.error.message ?? 'protocol error'));
      } else {
        pending?.resolve(message.result);
      }
    } else if (message.method !== undefined) {
      this.links.route(message.method, message.params ?? {});
    }
  }

  /** The frame went away: what is still pending fails. */
  close(): void {
    for (const pending of this.#pending.values()) pending.reject(new Error('frame detached'));
    this.#pending.clear();
  }
}

/** Routes a page session's `Target` events to its links; the page session is the root target. */
export function rootTarget(cdp: CDPSession): FrameTarget {
  const links = new FrameLinks((method, params) =>
    (cdp.send as (m: string, p: object) => Promise<unknown>)(method, params),
  );
  cdp.on('Target.attachedToTarget', (p) =>
    links.route('Target.attachedToTarget', p as unknown as Record<string, unknown>),
  );
  cdp.on('Target.receivedMessageFromTarget', (p) =>
    links.route('Target.receivedMessageFromTarget', p as unknown as Record<string, unknown>),
  );
  cdp.on('Target.detachedFromTarget', (p) =>
    links.route('Target.detachedFromTarget', p as unknown as Record<string, unknown>),
  );
  return { send: cdp.send.bind(cdp) as TargetSend, links };
}

/**
 * Attaches to the out-of-process frames directly below `target` (Chromium reports the existing
 * ones while it answers `Target.setAutoAttach`) and returns them. Frames created meanwhile are
 * attached as well and run on: nothing waits for this client.
 */
export async function childFrames(target: FrameTarget): Promise<FrameLink[]> {
  const before = target.links.attached.length;
  await target.send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: false,
    filter: [{ type: 'iframe', exclude: false }],
  });
  // The attach events precede the answer on the wire; let their delivery settle.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return target.links.attached.slice(before);
}
